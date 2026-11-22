import * as vscode from "vscode";
import { getLatestBuildForProject } from "../aws/codebuildService";
import { fetchFullBuildLog, isLogStreamingCancellationError } from "../aws/logsService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore } from "../state/store";
import { logError, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import {
    formatSanitizedScope,
    resolveBuildFromArg,
    resolveProjectNameFromArg,
    sanitizeBuildId
} from "./shared";
import { getBuildLogsPanelManager, type BuildLogsOpenResult } from "../ui/buildLogsPanel";

type ResolvedLogTarget = {
    profile: string;
    region: string;
    buildId: string;
    projectName: string;
};

/**
 * Falls back to whichever build the user currently has focused in a log panel, so the
 * "View Full Log" editor-title button works without needing a tree selection argument.
 */
function resolveFromActiveLogPanel(): ResolvedLogTarget | undefined {
    const header = getBuildLogsPanelManager().getActiveHeader();
    if (!header) {
        return undefined;
    }

    return {
        profile: header.profile,
        region: header.region,
        buildId: header.buildId,
        projectName: header.projectName
    };
}

export async function viewFullLogs(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const selectedBuild = resolveBuildFromArg(arg);
    const fromActiveEditor = selectedBuild ? undefined : resolveFromActiveLogPanel();

    let profile = selectedBuild?.profile ?? fromActiveEditor?.profile ?? state.currentProfile;
    let region = selectedBuild?.region ?? fromActiveEditor?.region ?? state.currentRegion;
    let buildId = selectedBuild?.id ?? fromActiveEditor?.buildId;
    let projectName = selectedBuild?.projectName ?? fromActiveEditor?.projectName ?? resolveProjectNameFromArg(arg);

    if (!profile) {
        void notify("warning", `Select an AWS profile before viewing logs in ${formatScope(profile, region)}`);
        return;
    }

    if (!buildId && !projectName) {
        if (state.projects.length === 0) {
            void notify("info", `No CodeBuild projects available to view logs in ${formatScope(profile, region)}`);
            return;
        }

        projectName = await vscode.window.showQuickPick(state.projects.map((project) => project.name), {
            title: "Select Project for Full Log"
        });
    }

    if (!buildId && projectName) {
        const latestBuild = await getLatestBuildForProject(
            profile,
            region,
            projectName,
            { secretStorage: context.secrets }
        );

        if (!latestBuild) {
            void notify("info", `No builds found for ${formatProjectScope(projectName, profile, region)}`);
            return;
        }

        buildId = latestBuild.id;
        projectName = latestBuild.projectName;
    }

    if (!buildId) {
        void notify("warning", `Unable to resolve build ID for logs in ${formatScope(profile, region)}`);
        return;
    }

    const resolvedProfile = profile;
    const resolvedRegion = region;
    const resolvedBuildId = buildId;
    const resolvedProjectName = projectName ?? "unknown-project";

    let session: BuildLogsOpenResult;
    try {
        session = await getBuildLogsPanelManager().open(
            {
                projectName: resolvedProjectName,
                profile: resolvedProfile,
                region: resolvedRegion,
                buildId: resolvedBuildId,
                mode: "full"
            },
            { unbounded: true }
        );
    } catch (error) {
        logError(`[LOGS] Failed to open full log panel: ${sanitizeLogValue(String(error))}`);
        void notify("error", `Unable to open the full log for ${resolvedBuildId} in ${formatScope(resolvedProfile, resolvedRegion)}`);
        return;
    }

    // Already loading, or loaded within the retention window: the panel was just revealed.
    if (session.reused) {
        return;
    }

    const { handle } = session;
    const abortController = new AbortController();
    handle.registerCanceller(() => abortController.abort());

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Loading full log for ${sanitizeBuildId(resolvedBuildId)}`,
            cancellable: true
        },
        async (progress, token) => {
            token.onCancellationRequested(() => abortController.abort());

            try {
                const result = await fetchFullBuildLog(resolvedProfile, resolvedRegion, resolvedBuildId, {
                    secretStorage: context.secrets,
                    signal: abortController.signal,
                    onWaiting: (message) => {
                        handle.setWaitingMessage(message);
                        progress.report({ message });
                    },
                    onLines: (lines) => handle.appendLines(lines),
                    onProgress: (totalLines) => progress.report({ message: `${totalLines} line(s) fetched…` })
                });

                handle.finish(
                    "complete",
                    result.truncated
                        ? `Full log truncated after ${result.totalLines} line(s) (safety limit reached). Increase "codebuild.logsViewer.maxFullLogLines" to see more. Build status: ${result.status}.`
                        : `End of full log (${result.totalLines} line(s)). Build status: ${result.status}.`,
                    result.status
                );
            } catch (error) {
                if (isLogStreamingCancellationError(error)) {
                    handle.finish("stopped", "Full log loading cancelled.");
                    return;
                }

                const message = getUserFriendlyErrorMessage(error, {
                    profile: resolvedProfile,
                    region: resolvedRegion,
                    operation: "Loading full build log"
                });

                logError(`[LOGS] Full log fetch failed in ${formatSanitizedScope(resolvedProfile, resolvedRegion)}: ${sanitizeLogValue(message)}`);
                handle.finish("failed", `Failed to load the full log.\n${message}`);
                void notify("error", `Failed to load full log for ${resolvedBuildId} in ${formatScope(resolvedProfile, resolvedRegion)}`);
            }
        }
    );
}
