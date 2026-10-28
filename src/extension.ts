import * as vscode from "vscode";
import { createAppStore } from "./state/store";
import { getPersistedBuildTimeDisplayFormat } from "./state/timeDisplayPreference";
import { getPersistedFailedBuilds } from "./state/failedBuildsPersistence";
import { CodeBuildTreeDataProvider, type TreeNode } from "./ui/treeDataProvider";
import { initializeCommandState, loadBuildHistoryForProject, registerCodeBuildCommands } from "./commands";
import { BuildMonitor } from "./monitor/buildMonitor";
import { disposeLogsStreaming } from "./aws/logsService";
import { clearAwsClientCache } from "./aws/clientFactory";
import { getConfiguredMaxBatchSelectedProjects } from "./aws/batchTriggerManager";
import { logInfo, disposeOutputChannel } from "./logging/outputChannelManager";
import { formatScope, notify } from "./notifications/notifier";
import { registerBuildLogsDocumentProvider } from "./ui/buildLogsViewer";

let activeBuildMonitor: BuildMonitor | null = null;

export async function activate(context: vscode.ExtensionContext) {
    logInfo("BuildCompanion activated");

    const store = createAppStore({
        buildTimeDisplayFormat: getPersistedBuildTimeDisplayFormat(context),
        failedBuilds: getPersistedFailedBuilds(context)
    });
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

        const maxSelectedProjects = getConfiguredMaxBatchSelectedProjects();
        let selectedCount = store.getSelectedProjects(profile, state.currentRegion).length;
        let rejectedCount = 0;

        for (const [element, checkboxState] of event.items) {
            if (element.kind !== "project") {
                continue;
            }

            const wantsSelected = checkboxState === vscode.TreeItemCheckboxState.Checked;
            const wasSelected = store.isProjectSelected(element.project.name, profile, state.currentRegion);

            if (wantsSelected && !wasSelected && selectedCount >= maxSelectedProjects) {
                rejectedCount += 1;
                continue;
            }

            store.setProjectSelected(element.project.name, profile, state.currentRegion, wantsSelected);
            if (wantsSelected !== wasSelected) {
                selectedCount += wantsSelected ? 1 : -1;
            }
        }

        if (rejectedCount > 0) {
            // The view already painted the checkbox as checked; refresh so it reverts to match the
            // store, which never recorded the over-limit selection.
            treeDataProvider.refresh();
            void notify(
                "warning",
                `Selection limit reached: up to ${maxSelectedProjects} project(s) can be selected for a batch deployment at once.`,
                {
                    detail: `${rejectedCount} project(s) were not selected. Raise the codebuild.batchDeploy.maxSelectedProjects setting to allow more.`
                }
            );
        }
    });

    context.subscriptions.push(treeDataProvider, treeView, checkboxStateSubscription);

    registerBuildLogsDocumentProvider(context);

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