import * as vscode from "vscode";
import {
    getProjectConfiguration,
    listCuratedEnvironmentImages,
    updateProjectConfiguration
} from "../aws/codebuildService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore } from "../state/store";
import { logError, logInfo, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatScope, notify } from "../notifications/notifier";
import { formatSanitizedScope, resolveProjectNameFromArg, showShortStatusMessage } from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";
import { buildConfigurationChanges, buildConfigurationDiffLines, runProjectConfigurationWizard } from "./projectConfigurationWizard";

/**
 * Permanently updates a project's build configuration (environment variables, image, compute
 * type, buildspec, privileged mode, timeouts). Unlike "Start Build with Overrides", changes made
 * here are written back to the live project via UpdateProject and affect every future build
 * until changed again.
 */
export async function editProjectConfiguration(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const profile = state.currentProfile;
    const region = state.currentRegion;

    if (!profile) {
        void notify("warning", `Select an AWS profile before editing project configuration in ${formatScope(profile, region)}`);
        return;
    }

    let projectName = resolveProjectNameFromArg(arg);
    if (!projectName) {
        if (state.projects.length === 0) {
            void notify("info", `No CodeBuild projects available in ${formatScope(profile, region)}`);
            return;
        }

        projectName = await vscode.window.showQuickPick(state.projects.map((project) => project.name), {
            title: "Select Project to Edit"
        });
    }

    if (!projectName) {
        return;
    }

    const resolvedProjectName = projectName;

    if (!await ensureDestructiveActionsAllowed(context, store, profile, region, "Edit Project Configuration")) {
        return;
    }

    try {
        const baseline = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Loading configuration for ${resolvedProjectName}...`
            },
            () => getProjectConfiguration(profile, region, resolvedProjectName, { secretStorage: context.secrets })
        );

        const result = await runProjectConfigurationWizard({
            mode: "permanent",
            projectName: resolvedProjectName,
            baseline,
            includeBranch: false,
            loadCuratedImages: () => listCuratedEnvironmentImages(profile, region, { secretStorage: context.secrets })
        });

        if (!result.confirmed) {
            return;
        }

        const diff = buildConfigurationDiffLines({
            baseline,
            draft: result.draft,
            includeBranch: false
        });

        if (diff.length === 0) {
            return;
        }

        const confirmation = await notify(
            "warning",
            `Update the '${resolvedProjectName}' project configuration?`,
            {
                modal: true,
                detail: `This PERMANENTLY changes project settings. Every future build (manual, webhook, or pipeline-triggered) will use these values until changed again:\n\u2022 ${diff.join("\n\u2022 ")}`,
                actions: ["Update Project"]
            }
        );

        if (confirmation !== "Update Project") {
            return;
        }

        const changes = buildConfigurationChanges(baseline, result.draft);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Updating configuration for ${resolvedProjectName}...`
            },
            () => updateProjectConfiguration(profile, region, resolvedProjectName, changes, { secretStorage: context.secrets })
        );

        logInfo(
            `[SETTINGS] Updated project configuration for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)}): ${diff.length} field(s) changed`
        );
        showShortStatusMessage(`Project configuration updated for ${resolvedProjectName}`);
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Updating project configuration",
            requiredPermissions: ["codebuild:BatchGetProjects", "codebuild:UpdateProject"]
        });
        logError(
            `[SETTINGS] Failed to update project configuration for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)}): ${sanitizeLogValue(message)}`
        );
        void notify("error", `Unable to update project configuration for ${resolvedProjectName}`);
    }
}
