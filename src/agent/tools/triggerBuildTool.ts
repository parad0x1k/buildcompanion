import * as vscode from "vscode";
import { getLatestBuildForProject, isBuildInProgress, startCodeBuild } from "../../aws/codebuildService";
import { getDestructiveActionBlockReason } from "../../commands/profileCommands";
import { setProjectStatus } from "../../commands/shared";
import { logError, logInfo, sanitizeLogValue } from "../../logging/outputChannelManager";
import type { AppStore, BuildState } from "../../state/store";
import {
    describeScopeForModel,
    formatScopeForModel,
    formatScopeForUser,
    isAgentToolError,
    isExplicitScopeRequiredForBuilds,
    resolveAgentScope,
    type ResolvedAgentScope
} from "../scope";
import { releaseTriggerLock, tryAcquireTriggerLock } from "../singleFlightGuard";
import { buildErrorResult, toToolResult, validationError, type AgentToolError, type AgentToolResult } from "../types";

export interface TriggerBuildToolInput {
    profile?: string;
    region?: string;
    project_name: string;
    branch?: string;
}

type TriggerBuildSuccess = {
    buildId: string;
    status: string;
    profile?: string;
    region: string;
    usedCurrentSelection: boolean;
    projectName: string;
    branch?: string;
};

// How long a confirmed scope stays pinned between prepareInvocation (the dialog the user sees)
// and invoke (the actual StartBuild). Long enough for someone to read the dialog; short enough
// that a stale entry can't outlive the conversation turn it belongs to.
const CONFIRMED_SCOPE_TTL_MS = 10 * 60 * 1000;

function confirmationKey(input: TriggerBuildToolInput): string {
    return JSON.stringify([
        input.profile?.trim() ?? "",
        input.region?.trim() ?? "",
        input.project_name?.trim() ?? "",
        input.branch?.trim() ?? ""
    ]);
}

/**
 * Agent-callable "trigger a build" tool. Built on the same `startCodeBuild` call and store-merge
 * pattern as the human trigger/batch-deploy flows (see triggerBuild.ts and batchDeploy.ts's
 * onBuildTriggered callback).
 *
 * Profile and region are optional: when omitted, the user's current BuildCompanion selection is
 * used, so agents don't need to ask for values the user already chose. That stays safe because:
 * - the scope comes from the user's own explicit choice in the BuildCompanion view, never from
 *   anything the model supplies or guesses;
 * - the confirmation dialog spells out the exact profile and region (with real names - that
 *   dialog is shown to the user, not sent to the model);
 * - the scope shown in that dialog is pinned, and the build is refused if the selection changes
 *   before it starts;
 * - `codebuild.agentTools.requireExplicitScopeForBuilds` restores "the agent must name both".
 */
export class TriggerBuildTool implements vscode.LanguageModelTool<TriggerBuildToolInput> {
    private readonly confirmedScopes = new Map<string, { profile: string; region: string; expiresAtMs: number }>();

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: AppStore
    ) {}

    public async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<TriggerBuildToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const projectName = options.input.project_name?.trim() || "(missing project)";
        const branch = options.input.branch?.trim();
        const branchLabel = branch ? `branch/source version \`${branch}\`` : "the project's default source version";
        const scope = this.resolveScope(options.input);

        if (isAgentToolError(scope)) {
            // invoke() returns the same error without starting anything; no confirmation needed.
            return { invocationMessage: `Checking build request for ${projectName}` };
        }

        this.pinConfirmedScope(options.input, scope);

        const selectionNote = scope.source === "selection"
            ? "\n\nThis is your current BuildCompanion selection. Change it in the BuildCompanion view first if you meant a different account or region."
            : "";

        return {
            invocationMessage: `Starting a build for ${projectName} (${formatScopeForUser(scope)})`,
            confirmationMessages: {
                title: "Start a CodeBuild build?",
                message: new vscode.MarkdownString(
                    `Start a build for **${projectName}** using ${branchLabel}?\n\n` +
                        `- Profile: \`${scope.profile}\`\n- Region: \`${scope.region}\`` +
                        selectionNote +
                        "\n\nThis calls AWS CodeBuild's `StartBuild`, runs the project's configured build steps " +
                        "under its own service role, and may incur AWS cost. The build will appear in " +
                        "BuildCompanion's Active Builds view like any build triggered from the editor."
                )
            }
        };
    }

    public async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TriggerBuildToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        return toToolResult(await this.run(options.input));
    }

    private resolveScope(input: TriggerBuildToolInput): ResolvedAgentScope | AgentToolError {
        if (isExplicitScopeRequiredForBuilds() && (!input.profile?.trim() || !input.region?.trim())) {
            return validationError(
                "This workspace requires builds to name the AWS profile and region explicitly. " +
                    "Ask the user which profile and region to use, then pass both."
            );
        }

        return resolveAgentScope(this.store, input);
    }

    private pinConfirmedScope(input: TriggerBuildToolInput, scope: ResolvedAgentScope): void {
        const now = Date.now();
        for (const [key, entry] of this.confirmedScopes) {
            if (entry.expiresAtMs <= now) {
                this.confirmedScopes.delete(key);
            }
        }

        this.confirmedScopes.set(confirmationKey(input), {
            profile: scope.profile,
            region: scope.region,
            expiresAtMs: now + CONFIRMED_SCOPE_TTL_MS
        });
    }

    /** True if the user confirmed a different scope than the one this call would now use. */
    private takeScopeMismatch(input: TriggerBuildToolInput, scope: ResolvedAgentScope): boolean {
        const key = confirmationKey(input);
        const confirmed = this.confirmedScopes.get(key);
        this.confirmedScopes.delete(key);

        if (!confirmed || confirmed.expiresAtMs <= Date.now()) {
            return false;
        }

        return confirmed.profile !== scope.profile || confirmed.region !== scope.region;
    }

    private async run(input: TriggerBuildToolInput): Promise<AgentToolResult<TriggerBuildSuccess>> {
        const projectName = input.project_name?.trim();
        const branch = input.branch?.trim() || undefined;

        if (!projectName) {
            return validationError("project_name is required and must be non-empty.");
        }

        const scope = this.resolveScope(input);
        if (isAgentToolError(scope)) {
            return scope;
        }

        const { profile, region } = scope;
        const modelScope = describeScopeForModel(scope);
        const modelScopeLabel = formatScopeForModel(scope);

        if (this.takeScopeMismatch(input, scope)) {
            return {
                ok: false,
                errorType: "SCOPE_CHANGED",
                message: "The user's BuildCompanion profile or region changed after they confirmed this build, so nothing was started. " +
                    "Tell the user, and call this tool again only if they still want the build (they will be asked to confirm the new scope).",
                ...modelScope,
                projectName
            };
        }

        // Non-modal equivalent of ensureDestructiveActionsAllowed: its blocking modal has no
        // agent-reachable "click" path, so a block surfaces as a structured result instead.
        const blockReason = getDestructiveActionBlockReason(this.store, profile, region);
        if (blockReason) {
            return {
                ok: false,
                errorType: "BLOCKED",
                message: `Builds are currently blocked for ${modelScopeLabel} because BuildCompanion could not validate that scope. ` +
                    "Ask the user to run \"Switch Profile\" in BuildCompanion or resolve the underlying issue, then retry.",
                ...modelScope,
                projectName
            };
        }

        if (!tryAcquireTriggerLock(profile, region, projectName)) {
            return {
                ok: false,
                errorType: "ALREADY_IN_PROGRESS",
                message: `Another trigger_build call for ${projectName} in ${modelScopeLabel} is already in flight. ` +
                    "Wait for it to finish before retrying - do not call this tool again immediately.",
                ...modelScope,
                projectName
            };
        }

        try {
            // Mirrors triggerBuild.ts's in-progress check, but resolves it declaratively instead
            // of the human flow's "Wait / Trigger anyway / Cancel" modal, which has no
            // agent-clickable equivalent. triggerBuildBatch (the other existing trigger path)
            // does not perform this check at all, so it must happen here.
            const latestBuild = await getLatestBuildForProject(profile, region, projectName, {
                secretStorage: this.context.secrets
            });

            if (isBuildInProgress(latestBuild)) {
                return {
                    ok: false,
                    errorType: "ALREADY_IN_PROGRESS",
                    message: `A build is already in progress for ${projectName} in ${modelScopeLabel} ` +
                        `(build ID ${latestBuild?.id}). Ask the user whether to wait for it or proceed anyway before calling this tool again.`,
                    ...modelScope,
                    projectName
                };
            }

            const build = await startCodeBuild(profile, region, projectName, branch, {
                secretStorage: this.context.secrets
            });

            const latestState = this.store.getState();
            const nextActiveBuilds: BuildState[] = [
                ...latestState.activeBuilds.filter((activeBuild) => activeBuild.id !== build.id),
                build
            ];

            this.store.batchUpdate(() => {
                this.store.setActiveBuilds(nextActiveBuilds);
                this.store.setProjects(setProjectStatus(latestState.projects, projectName, build.status));
                this.store.markBuildAsExtensionTriggered(build.id);
            });

            logInfo(`[AGENT] trigger_build started ${sanitizeLogValue(build.id, "buildId")} for ${sanitizeLogValue(projectName)}`);

            return {
                ok: true,
                buildId: build.id,
                status: build.status,
                ...modelScope,
                projectName,
                branch
            };
        } catch (error) {
            const result = buildErrorResult(error, {
                scope,
                projectName,
                operation: "Triggering build",
                requiredPermissions: ["codebuild:StartBuild"]
            });
            logError(`[AGENT] trigger_build failed for ${sanitizeLogValue(projectName)}: ${sanitizeLogValue(result.message)}`);
            return result;
        } finally {
            releaseTriggerLock(profile, region, projectName);
        }
    }
}
