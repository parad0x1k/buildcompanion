import * as vscode from "vscode";
import { getLatestBuildForProject, isBuildInProgress, startCodeBuild } from "../../aws/codebuildService";
import { getDestructiveActionBlockReason } from "../../commands/profileCommands";
import { setProjectStatus } from "../../commands/shared";
import { logError, logInfo, sanitizeLogValue } from "../../logging/outputChannelManager";
import { formatProjectScope, formatScope } from "../../notifications/notifier";
import type { AppStore, BuildState } from "../../state/store";
import { releaseTriggerLock, tryAcquireTriggerLock } from "../singleFlightGuard";
import { buildErrorResult, toToolResult, validationError, type AgentToolResult } from "../types";

export interface TriggerBuildToolInput {
    profile: string;
    region: string;
    project_name: string;
    branch?: string;
}

type TriggerBuildSuccess = {
    buildId: string;
    status: string;
    profile: string;
    region: string;
    projectName: string;
    branch?: string;
};

/**
 * Agent-callable "trigger a build" tool. Deliberately built on the same `startCodeBuild` call and
 * store-merge pattern as the human trigger/batch-deploy flows (see triggerBuild.ts and
 * batchDeploy.ts's onBuildTriggered callback), but with every ambient-state lookup replaced by an
 * explicit, required input field - see design review for why reusing triggerBuild.ts's
 * `store.getState().currentProfile` lookup would be unsafe for a non-interactive caller.
 */
export class TriggerBuildTool implements vscode.LanguageModelTool<TriggerBuildToolInput> {
    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: AppStore
    ) {}

    public async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<TriggerBuildToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { profile, region, project_name: projectName, branch } = options.input;
        const scopeLabel = formatProjectScope(projectName || "(missing project)", profile || null, region || "(missing region)");
        const branchLabel = branch ? `branch/source version \`${branch}\`` : "the project's default source version";

        return {
            invocationMessage: `Starting a build for ${scopeLabel}`,
            confirmationMessages: {
                title: "Start a CodeBuild build?",
                message: new vscode.MarkdownString(
                    `Start a build for **${scopeLabel}** using ${branchLabel}?\n\n` +
                        "This calls AWS CodeBuild's `StartBuild`, runs the project's configured build steps " +
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

    private async run(input: TriggerBuildToolInput): Promise<AgentToolResult<TriggerBuildSuccess>> {
        const profile = input.profile?.trim();
        const region = input.region?.trim();
        const projectName = input.project_name?.trim();
        const branch = input.branch?.trim() || undefined;

        if (!profile || !region || !projectName) {
            return validationError("profile, region, and project_name are required and must be non-empty.");
        }

        // Non-modal equivalent of ensureDestructiveActionsAllowed: its blocking modal has no
        // agent-reachable "click" path, so a block surfaces as a structured result instead.
        const blockReason = getDestructiveActionBlockReason(this.store, profile, region);
        if (blockReason) {
            return {
                ok: false,
                errorType: "BLOCKED",
                message: `Destructive actions are currently blocked for ${formatScope(profile, region)}: ${blockReason}. ` +
                    "Ask the user to run \"Switch Profile\" in BuildCompanion or resolve the underlying issue, then retry.",
                profile,
                region,
                projectName
            };
        }

        if (!tryAcquireTriggerLock(profile, region, projectName)) {
            return {
                ok: false,
                errorType: "ALREADY_IN_PROGRESS",
                message: `Another trigger_build call for ${formatProjectScope(projectName, profile, region)} is already in flight. ` +
                    "Wait for it to finish before retrying - do not call this tool again immediately.",
                profile,
                region,
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
                    message: `A build is already in progress for ${formatProjectScope(projectName, profile, region)} ` +
                        `(build ID ${latestBuild?.id}). Ask the user whether to wait for it or proceed anyway before calling this tool again.`,
                    profile,
                    region,
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
                profile,
                region,
                projectName,
                branch
            };
        } catch (error) {
            const result = buildErrorResult(error, {
                profile,
                region,
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
