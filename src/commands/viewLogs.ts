import * as vscode from "vscode";
import { getLatestBuildForProject } from "../aws/codebuildService";
import { isLogStreamingCancellationError, streamBuildLogs } from "../aws/logsService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore } from "../state/store";
import { getOutputChannel, logError } from "../logging/outputChannelManager";
import { sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import {
    formatSanitizedScope,
    resolveBuildFromArg,
    resolveProjectNameFromArg,
    sanitizeBuildId
} from "./shared";

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

    getOutputChannel().show(true);

    void streamBuildLogs(
        profile,
        region,
        buildId,
        {
            secretStorage: context.secrets,
            onFailureSummary: (summary: string) => {
                const firstLine = summary.split("\n")[0] ?? "Build failed";
                logError(
                    `[LOGS] Build failed for ${sanitizeBuildId(buildId!)} in ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(firstLine)}`
                );
            }
        }
    ).catch((error) => {
        if (isLogStreamingCancellationError(error)) {
            return;
        }

        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Viewing logs"
        });

        logError(`[LOGS] Log streaming failed in ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(message)}`);
        void notify("error", `Log streaming failed for ${buildId} in ${formatScope(profile, region)}`);
    });
}
