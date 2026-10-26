import * as vscode from "vscode";
import {
    getLatestBuildForProject,
    getProjectConfiguration,
    isBuildInProgress,
    listCuratedEnvironmentImages,
    startCodeBuildWithOverrides
} from "../aws/codebuildService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore, BuildState } from "../state/store";
import { logError, logInfo, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import {
    formatSanitizedScope,
    hasProjectInScope,
    notifyDeploymentTriggered,
    resolveProjectNameFromArg,
    setProjectStatus,
    showShortStatusMessage,
    warnCompletionPopupsPaused
} from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";
import { buildConfigurationDiffLines, buildOverridesFromDraft, runProjectConfigurationWizard } from "./projectConfigurationWizard";

/**
 * Starts exactly one build using temporary, build-scoped overrides (branch, env vars, image,
 * compute type, buildspec, privileged mode, timeouts). Nothing picked here is ever written back
 * to the project - it mirrors the AWS Console's "Start build with overrides" screen.
 */
export async function startBuildWithOverrides(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const profile = state.currentProfile;
    const region = state.currentRegion;

    if (!profile) {
        void notify("warning", `Select an AWS profile before starting a build in ${formatScope(profile, region)}`);
        return;
    }

    if (!await ensureDestructiveActionsAllowed(context, store, profile, region, "Start Build with Overrides")) {
        return;
    }

    let projectName = resolveProjectNameFromArg(arg);
    if (!projectName) {
        if (state.projects.length === 0) {
            void notify("info", `No CodeBuild projects found in ${formatScope(profile, region)}`);
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
            `Project '${projectName}' is not available in ${formatScope(profile, region)}. Refresh and choose a project from the current scope before starting a build.`
        );
        return;
    }

    const resolvedProjectName = projectName;

    try {
        const latestBuild = await getLatestBuildForProject(profile, region, resolvedProjectName, { secretStorage: context.secrets });

        if (isBuildInProgress(latestBuild)) {
            const decision = await notify(
                "warning",
                `A build is already in progress for ${formatProjectScope(resolvedProjectName, profile, region)}`,
                {
                    modal: true,
                    detail: "CodeBuild projects can run multiple builds at once (subject to the project's concurrency limit). This does not queue - it starts immediately alongside the running build.",
                    actions: ["Start Anyway"]
                }
            );

            if (decision !== "Start Anyway") {
                return;
            }
        }

        const baseline = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Loading configuration for ${resolvedProjectName}...`
            },
            () => getProjectConfiguration(profile, region, resolvedProjectName, { secretStorage: context.secrets })
        );

        const initialBranch = store.getProjectBranchForScope(resolvedProjectName, profile, region)?.trim() || undefined;

        const result = await runProjectConfigurationWizard({
            mode: "override",
            projectName: resolvedProjectName,
            baseline,
            includeBranch: true,
            initialBranch,
            loadCuratedImages: () => listCuratedEnvironmentImages(profile, region, { secretStorage: context.secrets })
        });

        if (!result.confirmed) {
            return;
        }

        const diff = buildConfigurationDiffLines({
            baseline,
            draft: result.draft,
            includeBranch: true,
            baselineBranch: initialBranch,
            draftBranch: result.branch
        });

        const confirmation = await notify(
            "info",
            `Start one build for ${formatProjectScope(resolvedProjectName, profile, region)} with temporary overrides?`,
            {
                modal: true,
                detail: diff.length > 0
                    ? `These settings apply ONLY to this build. The project's saved configuration will not change:\n\u2022 ${diff.join("\n\u2022 ")}`
                    : "No overrides are set - this starts a normal build using the project's current saved configuration.",
                actions: ["Start Build"]
            }
        );

        if (confirmation !== "Start Build") {
            return;
        }

        if (result.branch) {
            store.setProjectBranchForScope(resolvedProjectName, result.branch, profile, region);
        }

        showShortStatusMessage(`Build trigger started for ${formatProjectScope(resolvedProjectName, profile, region)}`);

        const overrides = buildOverridesFromDraft(baseline, result.draft, result.branch);
        const build = await startCodeBuildWithOverrides(profile, region, resolvedProjectName, overrides, {
            secretStorage: context.secrets
        });

        notifyDeploymentTriggered(resolvedProjectName, profile, region, result.branch);

        const latestState = store.getState();
        const nextActiveBuilds: BuildState[] = [
            ...latestState.activeBuilds.filter((activeBuild) => activeBuild.id !== build.id),
            build
        ];

        store.batchUpdate(() => {
            store.setActiveBuilds(nextActiveBuilds);
            store.setProjects(setProjectStatus(latestState.projects, resolvedProjectName, build.status));
        });

        showShortStatusMessage(`Build started for ${formatProjectScope(resolvedProjectName, profile, region)}`);
        logInfo(
            `[BUILD] Build started with ${diff.length} override(s) for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)})`
        );
        warnCompletionPopupsPaused(state);
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Starting build with overrides"
        });
        const failureMessage = `Build trigger failed for ${formatProjectScope(resolvedProjectName, profile, region)}`;
        logError(
            `[BUILD] Build trigger (with overrides) failed for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)}): ${sanitizeLogValue(message)}`
        );
        void notify("error", failureMessage);
    }
}
