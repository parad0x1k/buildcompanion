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
import { buildLogsDocumentUri, getBuildLogsDocumentProvider } from "../ui/buildLogsViewer";

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

    const provider = getBuildLogsDocumentProvider();
    const uri = buildLogsDocumentUri(profile, region, resolvedBuildId);
    provider.open(uri, { projectName: resolvedProjectName, profile, region, buildId: resolvedBuildId });

    try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside
        });
    } catch (error) {
        logError(`[LOGS] Failed to open log viewer document: ${sanitizeLogValue(String(error))}`);
    }

    const abortController = new AbortController();
    provider.registerCanceller(uri, () => abortController.abort());

    void streamBuildLogs(
        profile,
        region,
        resolvedBuildId,
        {
            secretStorage: context.secrets,
            signal: abortController.signal,
            onLogLines: (lines: string[]) => provider.appendLines(uri, lines),
            onComplete: (status) => {
                provider.setFooter(uri, `── End of log stream (build status: ${status}) ──`);
            },
            onFailureSummary: (summary: string) => {
                const firstLine = summary.split("\n")[0] ?? "Build failed";
                logError(
                    `[LOGS] Build failed for ${sanitizeBuildId(resolvedBuildId)} in ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(firstLine)}`
                );
                provider.setFooter(uri, `── Build FAILED ──\n${summary}`);
            }
        }
    ).catch((error) => {
        if (isLogStreamingCancellationError(error)) {
            provider.setFooter(uri, "── Log streaming stopped ──");
            return;
        }

        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Viewing logs"
        });

        logError(`[LOGS] Log streaming failed in ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(message)}`);
        provider.setFooter(uri, `── Log streaming failed ──\n${message}`);
        void notify("error", `Log streaming failed for ${resolvedBuildId} in ${formatScope(profile, region)}`);
    });
}
