import * as vscode from "vscode";
import type { AppStore } from "../state/store";
import { formatScope, notify } from "../notifications/notifier";
import {
    promptForBranchSelection,
    resolveProjectNameFromArg,
    showShortStatusMessage
} from "./shared";

export async function setBranch(store: AppStore, arg?: unknown): Promise<void> {
    const state = store.getState();
    let projectName = resolveProjectNameFromArg(arg);

    if (!projectName) {
        if (state.projects.length === 0) {
            void notify("info", `No CodeBuild projects available to set a branch in ${formatScope(state.currentProfile, state.currentRegion)}`);
            return;
        }

        projectName = await vscode.window.showQuickPick(state.projects.map((project) => project.name), {
            title: "Select Project for Branch"
        });
    }

    if (!projectName) {
        return;
    }

    const branch = await promptForBranchSelection({
        title: `Set branch for ${projectName}`,
        prompt: "Leave empty to clear saved branch",
        initialValue: store.getProjectBranchForScope(projectName, state.currentProfile, state.currentRegion) ?? ""
    });

    if (branch === undefined) {
        return;
    }

    store.setProjectBranchForScope(projectName, branch.trim(), state.currentProfile, state.currentRegion);
}

export async function clearAllSavedBranches(store: AppStore): Promise<void> {
    const state = store.getState();
    const savedBranchCount = Object.keys(state.projectBranches).length;

    if (savedBranchCount === 0) {
        void notify("info", "No saved project branches to clear.");
        return;
    }

    const confirm = await notify(
        "warning",
        "Clear all saved project branches?",
        {
            modal: true,
            detail: `This removes ${savedBranchCount} saved branch mapping(s) across all profiles and regions.`,
            actions: ["Clear All Branches"]
        }
    );

    if (confirm !== "Clear All Branches") {
        return;
    }

    store.clearAllProjectBranches();
    showShortStatusMessage(`Cleared ${savedBranchCount} saved branch mapping(s).`);
}
