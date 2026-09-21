import * as vscode from "vscode";
import { createAppStore } from "./state/store";
import { CodeBuildTreeDataProvider, type TreeNode } from "./ui/treeDataProvider";
import { initializeCommandState, loadBuildHistoryForProject, registerCodeBuildCommands } from "./commands";
import { BuildMonitor } from "./monitor/buildMonitor";
import { disposeLogsStreaming } from "./aws/logsService";
import { clearAwsClientCache } from "./aws/clientFactory";
import { logInfo, disposeOutputChannel } from "./logging/outputChannelManager";
import { formatScope, notify } from "./notifications/notifier";

let activeBuildMonitor: BuildMonitor | null = null;

export async function activate(context: vscode.ExtensionContext) {
    logInfo("BuildCompanion activated");

    const store = createAppStore();
    context.subscriptions.push(store);

    try {
        await initializeCommandState(context, store);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown initialization error";
        void notify("error", `Initialization failed in ${formatScope(null, "unknown-region")}: ${message}`);
        return;
    }

    const treeDataProvider = new CodeBuildTreeDataProvider(
        store,
        (profile, region, projectName) => loadBuildHistoryForProject(context, store, profile, region, projectName)
    );
    void vscode.commands.executeCommand("setContext", "codebuild.canSelectMultipleProjects", false);
    void vscode.commands.executeCommand("setContext", "codebuild.hasSavedBranches", false);

    const treeView = vscode.window.createTreeView<TreeNode>("codebuildView", {
        treeDataProvider,
        showCollapseAll: true,
        manageCheckboxStateManually: true
    });

    const checkboxStateSubscription = treeView.onDidChangeCheckboxState((event) => {
        const state = store.getState();
        const profile = state.currentProfile;
        if (!profile) {
            return;
        }

        for (const [element, checkboxState] of event.items) {
            if (element.kind !== "project") {
                continue;
            }

            store.setProjectSelected(
                element.project.name,
                profile,
                state.currentRegion,
                checkboxState === vscode.TreeItemCheckboxState.Checked
            );
        }
    });

    context.subscriptions.push(treeDataProvider, treeView, checkboxStateSubscription);

    activeBuildMonitor?.dispose();
    activeBuildMonitor = new BuildMonitor(context, store);
    activeBuildMonitor.start();
    context.subscriptions.push(activeBuildMonitor);

    context.subscriptions.push({
        dispose: () => {
            disposeLogsStreaming();
        }
    });

    registerCodeBuildCommands({ context, store });
}

export function deactivate() {
    // activeBuildMonitor is already in context.subscriptions and will be disposed by VS Code.
    activeBuildMonitor = null;
    disposeLogsStreaming();
    clearAwsClientCache();
    disposeOutputChannel();
}