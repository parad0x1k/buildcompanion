import * as vscode from "vscode";
import { getLatestBuildForProject } from "../aws/codebuildService";
import { isLogStreamingCancellationError, streamBuildLogs } from "../aws/logsService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore } from "../state/store";
import { logError } from "../logging/outputChannelManager";
import { sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import {
    formatSanitizedScope,
    resolveBuildFromArg,
    resolveProjectNameFromArg,
    sanitizeBuildId
} from "./shared";
import { getBuildLogsPanelManager, type BuildLogsOpenResult } from "../ui/buildLogsPanel";

export async function viewLogs(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const selectedBuild = resolveBuildFromArg(arg);

    const profile = selectedBuild?.profile ?? state.currentProfile;
    const region = selectedBuild?.region ?? state.currentRegion;

    if (!profile) {
        void notify("warning", `Select an AWS profile before viewing logs in ${formatScope(profile, region)}`);
        return;
    }

    let buildId = selectedBuild?.id;
    let projectName = selectedBuild?.projectName ?? resolveProjectNameFromArg(arg);

    if (!buildId && !projectName) {
        if (state.projects.length === 0) {
            void notify("info", `No CodeBuild projects available to view logs in ${formatScope(profile, region)}`);
            return;
        }

        projectName = await vscode.window.showQuickPick(state.projects.map((project) => project.name), {
            title: "Select Project for Logs"
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

    const resolvedBuildId = buildId;
    const resolvedProjectName = projectName ?? "unknown-project";

    let session: BuildLogsOpenResult;
    try {
        session = await getBuildLogsPanelManager().open({
            projectName: resolvedProjectName,
            profile,
            region,
            buildId: resolvedBuildId,
            mode: "tail"
        });
    } catch (error) {
        logError(`[LOGS] Failed to open log panel: ${sanitizeLogValue(String(error))}`);
        void notify("error", `Unable to open logs for ${resolvedBuildId} in ${formatScope(profile, region)}`);
        return;
    }

    // Still streaming, or finished within the retention window: the panel was just revealed.
    if (session.reused) {
        return;
    }

    const { handle } = session;
    const abortController = new AbortController();
    handle.registerCanceller(() => abortController.abort());

    // streamBuildLogs reports the failure summary before onComplete; keep it so the final
    // footer shows it instead of being replaced by the generic end-of-stream line.
    let failureSummary: string | undefined;

    void streamBuildLogs(
        profile,
        region,
        resolvedBuildId,
        {
            secretStorage: context.secrets,
            signal: abortController.signal,
            onWaiting: (message: string) => handle.setWaitingMessage(message),
            onLogLines: (lines: string[]) => handle.appendLines(lines),
            onComplete: (status) => {
                handle.finish(
                    "complete",
                    failureSummary
                        ? `Build ${status}. Likely cause:\n${failureSummary}`
                        : `End of log stream (build status: ${status}).`,
                    status
                );
            },
            onFailureSummary: (summary: string) => {
                const firstLine = summary.split("\n")[0] ?? "Build failed";
                logError(
                    `[LOGS] Build failed for ${sanitizeBuildId(resolvedBuildId)} in ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(firstLine)}`
                );
                failureSummary = summary;
            }
        }
    ).catch((error) => {
        if (isLogStreamingCancellationError(error)) {
            handle.finish("stopped", "Log streaming stopped.");
            return;
        }

        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Viewing logs"
        });

        logError(`[LOGS] Log streaming failed in ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(message)}`);
        handle.finish("failed", `Log streaming failed.\n${message}`);
        void notify("error", `Log streaming failed for ${resolvedBuildId} in ${formatScope(profile, region)}`);
    });
}
