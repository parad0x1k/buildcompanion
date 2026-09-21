import * as vscode from "vscode";
import { getLatestBuildForProject, isBuildInProgress, startCodeBuild } from "../aws/codebuildService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore, BuildState } from "../state/store";
import { logError } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import {
    formatBranchForNotification,
    formatSanitizedScope,
    hasProjectInScope,
    notifyDeploymentTriggered,
    promptForBranchSelection,
    resolveProjectNameFromArg,
    setProjectStatus,
    showShortStatusMessage,
    warnCompletionPopupsPaused
} from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";
import { sanitizeLogValue } from "../logging/outputChannelManager";

export async function triggerBuild(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const profile = state.currentProfile;

    if (!profile) {
        void notify("warning", `Select an AWS profile before triggering a build in ${formatScope(profile, state.currentRegion)}`);
        return;
    }

    if (!await ensureDestructiveActionsAllowed(context, store, profile, state.currentRegion, "Trigger Build")) {
        return;
    }

    let projectName = resolveProjectNameFromArg(arg);
    if (!projectName) {
        if (state.projects.length === 0) {
            void notify("info", `No CodeBuild projects found in ${formatScope(profile, state.currentRegion)}`);
            return;
        }

        projectName = await vscode.window.showQuickPick(state.projects.map((project) => project.name), {
            title: "Select CodeBuild Project"
        });
    }

    if (!projectName) {
        return;
    }

    if (!hasProjectInScope(state.projects, projectName)) {
        void notify(
            "warning",
            `Project '${projectName}' is not available in ${formatScope(profile, state.currentRegion)}. Refresh and choose a project from the current scope before triggering a build.`
        );
        return;
    }

    try {
        const existingBranch = store.getProjectBranchForScope(projectName, profile, state.currentRegion)?.trim();
        let branch = existingBranch && existingBranch.length > 0 ? existingBranch : undefined;

        if (!branch) {
            const branchInput = await promptForBranchSelection({
                title: `Branch for ${projectName} (optional)`,
                prompt: "Leave empty to use project default source version",
                initialValue: ""
            });

            if (branchInput === undefined) {
                return;
            }

            const normalizedBranch = branchInput.trim();
            branch = normalizedBranch || undefined;
            if (branch) {
                store.setProjectBranchForScope(projectName, branch, profile, state.currentRegion);
            }
        }

        const latestBuild = await getLatestBuildForProject(
            profile,
            state.currentRegion,
            projectName,
            { secretStorage: context.secrets }
        );

        if (isBuildInProgress(latestBuild)) {
            const decision = await notify(
                "warning",
                `A build is already in progress for ${formatProjectScope(projectName, profile, state.currentRegion)}`,
                {
                    modal: true,
                    actions: ["Wait", "Trigger anyway"]
                }
            );

            if (decision === "Wait") {
                store.upsertPendingBuild({
                    projectName,
                    branch: branch || undefined,
                    profile,
                    region: state.currentRegion,
                    cancellationFenceToken: store.getScopeCancellationFence(profile, state.currentRegion)
                });
                showShortStatusMessage(`Build queued for ${formatProjectScope(projectName, profile, state.currentRegion)}`);

                if (!store.getState().autoRefreshEnabled) {
                    void notify(
                        "warning",
                        `Build queued for ${formatProjectScope(projectName, profile, state.currentRegion)}, but auto-refresh is OFF.`,
                        {
                            detail: "Queued deployments only auto-start when auto-refresh polling is enabled."
                        }
                    );
                }

                return;
            }

            if (!decision || decision === "Cancel") {
                return;
            }
        }

        const confirmation = await notify(
            "warning",
            `Start build for ${formatProjectScope(projectName, profile, state.currentRegion)}?`,
            {
                modal: true,
                detail: `Branch: ${formatBranchForNotification(branch)}`,
                actions: ["Start Build"]
            }
        );

        if (confirmation !== "Start Build") {
            return;
        }

        showShortStatusMessage(`Build trigger started for ${formatProjectScope(projectName, profile, state.currentRegion)}`);

        const build = await startCodeBuild(profile, state.currentRegion, projectName, branch || undefined, {
            secretStorage: context.secrets
        });

        notifyDeploymentTriggered(projectName, profile, state.currentRegion, branch);

        const latestState = store.getState();
        const nextActiveBuilds: BuildState[] = [
            ...latestState.activeBuilds.filter((activeBuild) => activeBuild.id !== build.id),
            build
        ];

        store.batchUpdate(() => {
            store.setActiveBuilds(nextActiveBuilds);
            store.setProjects(setProjectStatus(latestState.projects, projectName, build.status));
        });

        showShortStatusMessage(`Build started for ${formatProjectScope(projectName, profile, state.currentRegion)}`);
        warnCompletionPopupsPaused(state);
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region: state.currentRegion,
            operation: "Triggering build"
        });
        const failureMessage = `Build trigger failed for ${formatProjectScope(projectName, profile, state.currentRegion)}`;
        logError(
            `[BUILD] Build trigger failed for ${sanitizeLogValue(projectName)} (${formatSanitizedScope(profile, state.currentRegion)}): ${sanitizeLogValue(message)}`
        );
        void notify("error", failureMessage);
    }
}
