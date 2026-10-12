import * as vscode from "vscode";
import { getLatestBuildForProject, isBuildInProgress, retryBuild as retryBuildService } from "../aws/codebuildService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore, BuildState } from "../state/store";
import { logError, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import {
    formatSanitizedScope,
    notifyDeploymentTriggered,
    resolveBuildFromArg,
    sanitizeBuildId,
    setProjectStatus,
    shortenId,
    showShortStatusMessage,
    warnCompletionPopupsPaused
} from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";

export async function retryBuild(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const selectedBuild = resolveBuildFromArg(arg);

    if (!selectedBuild) {
        void notify(
            "warning",
            `Select a completed build from Build History to retry in ${formatScope(state.currentProfile, state.currentRegion)}`
        );
        return;
    }

    const { profile, region, projectName, id: buildId } = selectedBuild;

    if (!await ensureDestructiveActionsAllowed(context, store, profile, region, "Retry Build")) {
        return;
    }

    try {
        const latestBuild = await getLatestBuildForProject(profile, region, projectName, {
            secretStorage: context.secrets
        });

        if (isBuildInProgress(latestBuild)) {
            const concurrencyDecision = await notify(
                "warning",
                `A build is already in progress for ${formatProjectScope(projectName, profile, region)}`,
                {
                    modal: true,
                    detail: "Retrying now starts a second, concurrent build for this project.",
                    actions: ["Retry Anyway"]
                }
            );

            if (concurrencyDecision !== "Retry Anyway") {
                return;
            }
        }
    } catch (error) {
        // Failing to pre-check for an in-progress build should not block retry outright;
        // fall through and let the retry call itself surface any real failure.
        logError(
            `[BUILD] Unable to check in-progress status before retry for ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(String(error))}`
        );
    }

    const confirm = await notify(
        "warning",
        `Retry build ${shortenId(buildId)} for ${formatProjectScope(projectName, profile, region)}?`,
        {
            modal: true,
            detail: selectedBuild.sourceVersion
                ? `This starts a new build for branch/source version '${selectedBuild.sourceVersion}', using the project's current configuration.`
                : "This starts a new build using the same source version and project configuration as the original build.",
            actions: ["Retry Build"]
        }
    );

    if (confirm !== "Retry Build") {
        return;
    }

    showShortStatusMessage(`Retrying build for ${formatProjectScope(projectName, profile, region)}...`);

    try {
        const build = await retryBuildService(profile, region, buildId, { secretStorage: context.secrets });

        const latestState = store.getState();
        const nextActiveBuilds: BuildState[] = [
            ...latestState.activeBuilds.filter((activeBuild) => activeBuild.id !== build.id),
            build
        ];

        store.batchUpdate(() => {
            store.setActiveBuilds(nextActiveBuilds);
            store.setProjects(setProjectStatus(latestState.projects, projectName, build.status));
        });

        notifyDeploymentTriggered(projectName, profile, region, build.sourceVersion);
        showShortStatusMessage(`Build retry started for ${formatProjectScope(projectName, profile, region)}`);
        warnCompletionPopupsPaused(state);
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Retrying build",
            requiredPermissions: ["codebuild:RetryBuild"]
        });
        const failureMessage = `Retry failed for ${formatProjectScope(projectName, profile, region)}`;
        logError(
            `[BUILD] Retry failed for ${sanitizeLogValue(projectName)} (${formatSanitizedScope(profile, region)}) build ${sanitizeBuildId(buildId)}: ${sanitizeLogValue(message)}`
        );
        void notify("error", failureMessage);
    }
}
