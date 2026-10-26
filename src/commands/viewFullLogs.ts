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
import {
    BUILD_LOGS_URI_SCHEME,
    buildFullLogsDocumentUri,
    getBuildLogsDocumentProvider
} from "../ui/buildLogsViewer";

type ResolvedLogTarget = {
    profile: string;
    region: string;
    buildId: string;
    projectName: string;
};

/**
 * Falls back to whichever build the user currently has open in a (tailing) log viewer tab, so
 * the "View Full Log" editor-title button works without needing a tree selection argument.
 */
function resolveFromActiveLogEditor(): ResolvedLogTarget | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri || activeUri.scheme !== BUILD_LOGS_URI_SCHEME) {
        return undefined;
    }

    const header = getBuildLogsDocumentProvider().getHeader(activeUri);
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
    const fromActiveEditor = selectedBuild ? undefined : resolveFromActiveLogEditor();

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

    const provider = getBuildLogsDocumentProvider();
    const uri = buildFullLogsDocumentUri(resolvedProfile, resolvedRegion, resolvedBuildId);
    provider.open(
        uri,
        { projectName: resolvedProjectName, profile: resolvedProfile, region: resolvedRegion, buildId: resolvedBuildId, mode: "full" },
        { unbounded: true }
    );

    try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside
        });
    } catch (error) {
        logError(`[LOGS] Failed to open full log viewer document: ${sanitizeLogValue(String(error))}`);
        return;
    }

    const abortController = new AbortController();
    provider.registerCanceller(uri, () => abortController.abort());

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
                    onLines: (lines) => provider.appendLines(uri, lines),
                    onProgress: (totalLines) => progress.report({ message: `${totalLines} line(s) fetched…` })
                });

                provider.setFooter(
                    uri,
                    result.truncated
                        ? `── Full log truncated after ${result.totalLines} line(s) (safety limit reached). Increase "codebuild.logsViewer.maxFullLogLines" to see more. Build status: ${result.status} ──`
                        : `── End of full log (${result.totalLines} line(s)). Build status: ${result.status} ──`
                );
            } catch (error) {
                if (isLogStreamingCancellationError(error)) {
                    provider.setFooter(uri, "── Full log loading cancelled ──");
                    return;
                }

                const message = getUserFriendlyErrorMessage(error, {
                    profile: resolvedProfile,
                    region: resolvedRegion,
                    operation: "Loading full build log"
                });

                logError(`[LOGS] Full log fetch failed in ${formatSanitizedScope(resolvedProfile, resolvedRegion)}: ${sanitizeLogValue(message)}`);
                provider.setFooter(uri, `── Failed to load full log ──\n${message}`);
                void notify("error", `Failed to load full log for ${resolvedBuildId} in ${formatScope(resolvedProfile, resolvedRegion)}`);
            }
        }
    );
}
