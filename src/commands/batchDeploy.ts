import * as vscode from "vscode";
import {
    MAX_BATCH_SELECTED_PROJECTS,
    MIN_BATCH_DELAY_MS,
    triggerBuildBatch,
    type BatchTriggerProject
} from "../aws/batchTriggerManager";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore, BuildState } from "../state/store";
import { getOutputChannel, logError } from "../logging/outputChannelManager";
import { sanitizeLogValue } from "../logging/outputChannelManager";
import { formatScope, notify } from "../notifications/notifier";
import {
    type ActiveBatchDeployment,
    type BatchCancellationController,
    canSelectAllVisibleProjects,
    createBatchCancellationController,
    formatDeploymentPreview,
    formatSanitizedScope,
    getSelectedProjectNames,
    getVisibleProjects,
    notifyDeploymentTriggered,
    promptForBranchSelection,
    setProjectStatus,
    showShortStatusMessage,
    warnCompletionPopupsPaused
} from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";

let nextBatchDeploymentId = 1;
let activeBatchDeployment: ActiveBatchDeployment | null = null;

export function clearActiveBatchDeployment(id: number): void {
    if (activeBatchDeployment?.id === id) {
        activeBatchDeployment = null;
    }
}

export function getScopedActiveBatchDeployment(
    profile: string,
    region: string
): ActiveBatchDeployment | null {
    if (
        activeBatchDeployment
        && activeBatchDeployment.profile === profile
        && activeBatchDeployment.region === region
    ) {
        return activeBatchDeployment;
    }
    return null;
}

export async function deployAll(
    context: vscode.ExtensionContext,
    store: AppStore
): Promise<void> {
    const state = store.getState();
    const profile = state.currentProfile;
    const region = state.currentRegion;

    if (!profile) {
        void notify("warning", `Select an AWS profile before deploying selected projects in ${formatScope(profile, region)}`);
        return;
    }

    if (!await ensureDestructiveActionsAllowed(context, store, profile, region, "Deploy All")) {
        return;
    }

    if (activeBatchDeployment) {
        void notify(
            "warning",
            `A selected deployment is already running in ${formatScope(activeBatchDeployment.profile, activeBatchDeployment.region)}.`,
            {
                detail: "Wait for it to finish or cancel it before starting another selected deployment."
            }
        );
        return;
    }

    const projectNames = getSelectedProjectNames(store, profile, region);
    if (projectNames.length === 0) {
        void notify("warning", `Select one or more projects before deploying in ${formatScope(profile, region)}`);
        return;
    }

    const projectCount = projectNames.length;
    if (projectCount > MAX_BATCH_SELECTED_PROJECTS) {
        void notify(
            "error",
            `Selected deployment exceeds the maximum of ${MAX_BATCH_SELECTED_PROJECTS} projects in ${formatScope(profile, region)}.`,
            {
                detail: `Reduce your selection from ${projectCount} projects before starting a batch deployment.`
            }
        );
        return;
    }

    const delayInput = await vscode.window.showInputBox({
        title: "Delay between builds (seconds)",
        prompt: `Enter a number greater than or equal to ${MIN_BATCH_DELAY_MS / 1000}`,
        value: "2",
        validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
                return "Delay is required";
            }

            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed)) {
                return "Delay must be a valid number";
            }

            if (parsed * 1000 < MIN_BATCH_DELAY_MS) {
                return `Delay must be at least ${MIN_BATCH_DELAY_MS / 1000} second(s)`;
            }

            return undefined;
        }
    });

    if (delayInput === undefined) {
        return;
    }

    const delayMs = Math.max(MIN_BATCH_DELAY_MS, Math.round(Number(delayInput.trim()) * 1000));
    const missingBranchProjects = projectNames.filter((projectName) => {
        const scopedBranch = store.getProjectBranchForScope(projectName, profile, region)?.trim();
        return !scopedBranch;
    });

    let fallbackBranch: string | undefined;
    if (missingBranchProjects.length > 0) {
        const fallbackBranchInput = await promptForBranchSelection({
            title: "Fallback branch for selected projects (optional)",
            prompt: `${missingBranchProjects.length} selected project(s) have no saved branch. Leave empty to use project defaults.`,
            initialValue: ""
        });

        if (fallbackBranchInput === undefined) {
            return;
        }

        fallbackBranch = fallbackBranchInput.trim() || undefined;
    }

    const batchProjects: BatchTriggerProject[] = projectNames.map((projectName) => {
        const scopedBranch = store.getProjectBranchForScope(projectName, profile, region)?.trim();
        return {
            projectName,
            branch: scopedBranch && scopedBranch.length > 0 ? scopedBranch : fallbackBranch
        };
    });

    const previewConfirmation = await notify(
        "warning",
        `Start deployment for ${projectCount} selected project(s) in ${formatScope(profile, region)}?`,
        {
            modal: true,
            detail: [
                `Delay between builds: ${delayMs / 1000}s`,
                "",
                "Project -> Branch",
                formatDeploymentPreview(batchProjects)
            ].join("\n"),
            actions: ["Start Deployment"]
        }
    );

    if (previewConfirmation !== "Start Deployment") {
        return;
    }

    getOutputChannel().show(true);
    showShortStatusMessage(`Selected deployment started in ${formatScope(profile, region)}`);
    warnCompletionPopupsPaused(state);

    const deploymentId = nextBatchDeploymentId;
    nextBatchDeploymentId += 1;

    const cancellationController: BatchCancellationController = createBatchCancellationController();
    activeBatchDeployment = {
        id: deploymentId,
        profile,
        region,
        cancel: cancellationController.cancel
    };

    void triggerBuildBatch(
        {
            projects: batchProjects,
            profile,
            region,
            delayMs,
            isCancelled: cancellationController.isCancelled,
            onBuildTriggered: ({ projectName, branch, build }) => {
                notifyDeploymentTriggered(projectName, profile, region, branch);

                const latestState = store.getState();
                const nextActiveBuilds: BuildState[] = [
                    ...latestState.activeBuilds.filter((activeBuild) => activeBuild.id !== build.id),
                    build
                ];

                store.batchUpdate(() => {
                    store.setActiveBuilds(nextActiveBuilds);
                    store.setProjects(setProjectStatus(latestState.projects, projectName, build.status));
                    store.removePendingBuild(projectName, profile, region);
                });
            }
        },
        { secretStorage: context.secrets }
    ).then((result) => {
        if (result.successfulBuilds.length > 0) {
            const latestState = store.getState();
            const nextActiveBuilds: BuildState[] = [
                ...latestState.activeBuilds,
                ...result.successfulBuilds.filter((newBuild) => (
                    !latestState.activeBuilds.some((activeBuild) => activeBuild.id === newBuild.id)
                ))
            ];

            let nextProjects = latestState.projects;
            for (const build of result.successfulBuilds) {
                nextProjects = setProjectStatus(nextProjects, build.projectName, build.status);
            }

            store.batchUpdate(() => {
                store.setActiveBuilds(nextActiveBuilds);
                store.setProjects(nextProjects);
            });
        }

        const startedBuildCount = result.successfulBuilds.length;
        const failedTriggerCount = result.failedProjects.length;
        const failedProjectNames = result.failedProjects.map((failedProject) => failedProject.projectName);
        const shownFailedProjectNames = failedProjectNames.slice(0, 10).join(", ");
        const remainingFailedCount = Math.max(0, failedProjectNames.length - 10);

        const failureDetail = failedProjectNames.length === 0
            ? undefined
            : remainingFailedCount > 0
                ? `Failed to start: ${shownFailedProjectNames} (+${remainingFailedCount} more)`
                : `Failed to start: ${shownFailedProjectNames}`;

        const summary = `Deployment trigger batch ${result.cancelled ? "cancelled" : "finished"}: ${startedBuildCount} build start(s), ${failedTriggerCount} trigger failure(s) in ${formatScope(profile, region)}`;
        const cancelledDetail = result.cancelled
            ? "Remaining queued deployment starts were cancelled for this scope."
            : undefined;

        if (result.cancelled && failedTriggerCount === 0) {
            void notify("warning", summary, { detail: cancelledDetail });
            return;
        }

        if (failedTriggerCount === 0) {
            void notify("info", summary);
            return;
        }

        if (startedBuildCount === 0) {
            void notify("error", summary, {
                detail: [failureDetail, cancelledDetail].filter((part): part is string => Boolean(part)).join("\n") || undefined
            });
            return;
        }

        void notify("warning", summary, {
            detail: [failureDetail, cancelledDetail].filter((part): part is string => Boolean(part)).join("\n") || undefined
        });
    }).catch((error) => {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Batch deployment"
        });

        logError(`[BATCH] Batch deployment failed in ${formatSanitizedScope(profile, region)}: ${sanitizeLogValue(message)}`);
        void notify("error", `Batch deployment failed in ${formatScope(profile, region)}`);
    }).finally(() => {
        clearActiveBatchDeployment(deploymentId);
    });
}

export async function selectAllProjects(store: AppStore): Promise<void> {
    const state = store.getState();
    const profile = state.currentProfile;

    if (!profile) {
        void notify("warning", `Select an AWS profile before selecting projects in ${formatScope(profile, state.currentRegion)}`);
        return;
    }

    if (!canSelectAllVisibleProjects(state)) {
        void notify("warning", "Select All is available only when no search filter is applied or when search returns multiple projects.");
        return;
    }

    const visibleProjects = getVisibleProjects(store);
    if (visibleProjects.length === 0) {
        void notify("info", `No CodeBuild projects found in ${formatScope(profile, state.currentRegion)}`);
        return;
    }

    store.batchUpdate(() => {
        for (const project of visibleProjects) {
            store.setProjectSelected(project.name, profile, state.currentRegion, true);
        }
    });

    showShortStatusMessage(`Selected ${visibleProjects.length} project(s) in ${formatScope(profile, state.currentRegion)}`);
}
