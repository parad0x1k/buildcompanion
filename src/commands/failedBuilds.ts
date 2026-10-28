import * as vscode from "vscode";
import type { AppStore } from "../state/store";
import { persistFailedBuilds } from "../state/failedBuildsPersistence";
import { formatScope, notify } from "../notifications/notifier";
import { resolveBuildFromArg, showShortStatusMessage } from "./shared";

export async function dismissFailedBuild(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const build = resolveBuildFromArg(arg);
    if (!build) {
        return;
    }

    store.removeFailedBuild(build.id);
    await persistFailedBuilds(context, store.getState().failedBuilds);
}

export async function clearFailedBuilds(context: vscode.ExtensionContext, store: AppStore): Promise<void> {
    const state = store.getState();
    if (!state.currentProfile) {
        void notify("warning", `Select an AWS profile before clearing failed builds in ${formatScope(state.currentProfile, state.currentRegion)}`);
        return;
    }

    store.clearFailedBuilds(state.currentProfile, state.currentRegion);
    await persistFailedBuilds(context, store.getState().failedBuilds);
    showShortStatusMessage(`Cleared failed builds in ${formatScope(state.currentProfile, state.currentRegion)}`);
}
