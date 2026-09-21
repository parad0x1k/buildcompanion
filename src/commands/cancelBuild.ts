import * as vscode from "vscode";
import { stopBuild } from "../aws/codebuildService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore, BuildState } from "../state/store";
import { logError } from "../logging/outputChannelManager";
import { sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import {
    formatSanitizedScope,
    resolveBuildFromArg,
    sanitizeBuildId,
    setProjectStatus,
    shortenId,
    showShortStatusMessage,
    type BuildArg
} from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";
import { getScopedActiveBatchDeployment } from "./batchDeploy";

export async function cancelBuild(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const selectedBuild = resolveBuildFromArg(arg);
    let buildToCancel = selectedBuild;

    if (!buildToCancel) {
        const inProgressBuilds = state.activeBuilds.filter((build) => build.status === "IN_PROGRESS");
        if (inProgressBuilds.length === 0) {
            void notify("info", `No active builds in ${formatScope(state.currentProfile, state.currentRegion)}`);
            return;
        }

        const selected = await vscode.window.showQuickPick(
            inProgressBuilds.map((build) => ({
                label: build.projectName,
                description: `${build.profile}/${build.region} • ${shortenId(build.id)}`,
                detail: build.id,
                build
            })),
            {
                title: "Select Active Build to Cancel",
                placeHolder: "Choose an in-progress build"
            }
        );

        if (!selected) {
            return;
        }

        buildToCancel = selected.build;
    }

    if (!buildToCancel) {
        return;
    }

    const requestedBuild = buildToCancel;

    const verifiedActiveBuild = state.activeBuilds.find((build) => (
        build.id === requestedBuild.id
        && build.profile === requestedBuild.profile
        && build.region === requestedBuild.region
        && build.status === "IN_PROGRESS"
    ));

    if (!verifiedActiveBuild) {
        void notify(
            "warning",
            `Cancellation requires a currently active build in ${formatScope(requestedBuild.profile, requestedBuild.region)}. Refresh and retry from the active build list.`
        );
        return;
    }

    buildToCancel = verifiedActiveBuild;

    if (!await ensureDestructiveActionsAllowed(
        context,
        store,
        buildToCancel.profile,
        buildToCancel.region,
        "Cancel Build"
    )) {
        return;
    }

    const confirm = await notify(
        "warning",
        "Cancel this build?",
        {
            modal: true,
            detail: `Project: ${buildToCancel.projectName}\nProfile: ${buildToCancel.profile}\nRegion: ${buildToCancel.region}\nBuild ID: ${shortenId(buildToCancel.id)}`,
            actions: ["Cancel Build"]
        }
    );

    if (confirm !== "Cancel Build") {
        return;
    }

    // A confirmed cancellation should also cancel any queued follow-up for this project/scope.
    store.removePendingBuild(buildToCancel.projectName, buildToCancel.profile, buildToCancel.region);

    showShortStatusMessage(`Cancelling build for ${formatProjectScope(buildToCancel.projectName, buildToCancel.profile, buildToCancel.region)}...`);

    try {
        const stoppedBuild = await stopBuild(
            buildToCancel.profile,
            buildToCancel.region,
            buildToCancel.id,
            { secretStorage: context.secrets }
        );

        const latestState = store.getState();
        const nextActiveBuilds = latestState.activeBuilds.filter((activeBuild) => activeBuild.id !== buildToCancel!.id);
        store.batchUpdate(() => {
            store.setActiveBuilds(nextActiveBuilds);
            store.setProjects(setProjectStatus(latestState.projects, stoppedBuild.projectName, stoppedBuild.status));
        });

        showShortStatusMessage(`Cancel succeeded for ${formatProjectScope(buildToCancel.projectName, buildToCancel.profile, buildToCancel.region)}`);
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile: buildToCancel.profile,
            region: buildToCancel.region,
            operation: `Cancelling build ${buildToCancel.id}`
        });
        const failureMessage = `Cancel failed for ${formatProjectScope(buildToCancel.projectName, buildToCancel.profile, buildToCancel.region)}`;
        logError(
            `[CANCEL] Cancel failed for ${sanitizeLogValue(buildToCancel.projectName)} (${formatSanitizedScope(buildToCancel.profile, buildToCancel.region)}): ${sanitizeLogValue(message)}`
        );
        void notify("error", failureMessage);
    }
}

export async function cancelAllBuilds(
    context: vscode.ExtensionContext,
    store: AppStore
): Promise<void> {
    const state = store.getState();
    const profile = state.currentProfile;
    const region = state.currentRegion;

    if (!profile) {
        void notify("warning", `Select an AWS profile before cancelling active builds in ${formatScope(profile, region)}`);
        return;
    }

    if (!await ensureDestructiveActionsAllowed(context, store, profile, region, "Cancel All")) {
        return;
    }

    const totalInProgressBuilds = state.activeBuilds.filter((build) => build.status === "IN_PROGRESS");
    const inProgressBuilds = totalInProgressBuilds.filter((build) => (
        build.profile === profile && build.region === region
    ));
    const queuedBuildsInScope = state.pendingBuilds.filter((build) => (
        build.profile === profile && build.region === region
    ));
    const scopedBatchDeployment = getScopedActiveBatchDeployment(profile, region);

    if (inProgressBuilds.length === 0 && queuedBuildsInScope.length === 0 && !scopedBatchDeployment) {
        if (totalInProgressBuilds.length > 0) {
            void notify(
                "info",
                `No active builds in selected scope ${formatScope(profile, region)}. There are ${totalInProgressBuilds.length} active build(s) in other profile/region scopes.`
            );
            return;
        }

        void notify("info", `No active builds in ${formatScope(profile, region)}`);
        return;
    }

    const details = [
        `In-progress builds in scope: ${inProgressBuilds.length}`,
        `Queued Wait deployments in scope: ${queuedBuildsInScope.length}`,
        `Selected deployment batch in scope: ${scopedBatchDeployment ? "active" : "none"}`
    ];
    const inProgressOutsideScopeCount = totalInProgressBuilds.length - inProgressBuilds.length;
    if (inProgressOutsideScopeCount > 0) {
        details.push(`${inProgressOutsideScopeCount} in-progress build(s) in other scopes are not affected.`);
    }

    const confirm = await notify(
        "warning",
        `Cancel active operations in ${formatScope(profile, region)}?`,
        {
            modal: true,
            detail: details.join("\n"),
            actions: ["Cancel All"]
        }
    );

    if (confirm !== "Cancel All") {
        return;
    }

    // Incrementing the fence prevents monitor-driven queued starts after cancellation confirmation.
    store.bumpScopeCancellationFence(profile, region);

    if (scopedBatchDeployment) {
        scopedBatchDeployment.cancel();
    }

    if (queuedBuildsInScope.length > 0) {
        store.removePendingBuildsForScope(profile, region);
    }

    if (inProgressBuilds.length === 0) {
        const cancelledParts: string[] = [];
        if (scopedBatchDeployment) {
            cancelledParts.push("selected deployment batch");
        }
        if (queuedBuildsInScope.length > 0) {
            cancelledParts.push(`${queuedBuildsInScope.length} queued Wait deployment(s)`);
        }

        showShortStatusMessage(`Cancelled ${cancelledParts.join(" and ")} in ${formatScope(profile, region)}`);
        return;
    }

    showShortStatusMessage(`Cancelling ${inProgressBuilds.length} active builds in ${formatScope(profile, region)}...`);

    const results = await Promise.allSettled(inProgressBuilds.map((build) => (
        stopBuild(build.profile, build.region, build.id, { secretStorage: context.secrets })
    )));

    const stoppedBuilds: BuildState[] = [];
    let failedCount = 0;

    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            stoppedBuilds.push(result.value);
            return;
        }

        failedCount += 1;
        const failedBuild = inProgressBuilds[index];
        const message = getUserFriendlyErrorMessage(result.reason, {
            profile: failedBuild.profile,
            region: failedBuild.region,
            operation: `Cancelling build ${failedBuild.id}`
        });
        logError(
            `[CANCEL] Failed to cancel build ${sanitizeBuildId(failedBuild.id)} in ${formatSanitizedScope(failedBuild.profile, failedBuild.region)}: ${sanitizeLogValue(message)}`
        );
    });

    if (stoppedBuilds.length > 0) {
        const stoppedIds = new Set(stoppedBuilds.map((build) => build.id));
        const latestState = store.getState();

        let nextProjects = latestState.projects;
        for (const stoppedBuild of stoppedBuilds) {
            nextProjects = setProjectStatus(nextProjects, stoppedBuild.projectName, stoppedBuild.status);
        }

        store.batchUpdate(() => {
            store.setActiveBuilds(latestState.activeBuilds.filter((build) => !stoppedIds.has(build.id)));
            store.setProjects(nextProjects);
        });
    }

    if (failedCount > 0) {
        void notify(
            "error",
            `Cancel failed for ${failedCount} build(s) in ${formatScope(profile, region)}. Cancelled ${stoppedBuilds.length} build(s).`
        );
        return;
    }

    showShortStatusMessage(`Cancel succeeded for ${stoppedBuilds.length} build(s) in ${formatScope(profile, region)}`);
}
