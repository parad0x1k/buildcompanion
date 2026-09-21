import * as vscode from "vscode";
import {
    listRecentActiveBuilds,
    listRecentBuildHistoryForProject
} from "../aws/codebuildService";
import { clearAwsClientCache } from "../aws/clientFactory";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore } from "../state/store";
import { getOutputChannel, logError, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatScope, notify } from "../notifications/notifier";
import { BUILD_HISTORY_LIMIT, showShortStatusMessage, type CommandDeps } from "./shared";
import { refreshProfilesAndProjects, switchProfile, switchRegionAndReload, setTemporaryCredentials } from "./profileCommands";
import { triggerBuild } from "./triggerBuild";
import { setBranch, clearAllSavedBranches } from "./branchCommands";
import { deployAll, selectAllProjects } from "./batchDeploy";
import { cancelBuild, cancelAllBuilds } from "./cancelBuild";
import { viewLogs } from "./viewLogs";

let sharedLogsOutputChannel: vscode.OutputChannel | undefined;

export async function loadBuildHistoryForProject(
    context: vscode.ExtensionContext,
    store: AppStore,
    profile: string,
    region: string,
    projectName: string
): Promise<void> {
    try {
        const entries = await listRecentBuildHistoryForProject(
            profile,
            region,
            projectName,
            BUILD_HISTORY_LIMIT,
            { secretStorage: context.secrets }
        );

        const configuredMax = vscode.workspace.getConfiguration("codebuild").get<number>(
            "buildHistory.maxEntriesPerProject",
            BUILD_HISTORY_LIMIT
        );
        const maxEntries = Number.isFinite(configuredMax) && configuredMax > 0
            ? Math.floor(configuredMax)
            : BUILD_HISTORY_LIMIT;

        store.setProjectBuildHistory(profile, region, projectName, entries, maxEntries);
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: `Loading build history for ${projectName}`
        });
        logError(`[HISTORY] ${sanitizeLogValue(message)}`);
        throw new Error(message);
    }
}

function openTerminal(): void {
    const terminal = vscode.window.createTerminal("AWS Setup");
    terminal.show();
}

async function searchProjects(store: AppStore): Promise<void> {
    const query = await vscode.window.showInputBox({
        title: "Search CodeBuild Projects",
        placeHolder: "Enter project name"
    });

    store.setProjectFilter(query ?? "");
}

function clearProjectSearch(store: AppStore): void {
    store.setProjectFilter("");
}

function toggleAutoRefresh(store: AppStore): void {
    const state = store.getState();
    const nextEnabled = !state.autoRefreshEnabled;
    store.setAutoRefreshEnabled(nextEnabled);
    showShortStatusMessage(
        `Auto-refresh ${nextEnabled ? "enabled" : "disabled"} in ${formatScope(state.currentProfile, state.currentRegion)}`
    );
}

export function registerCodeBuildCommands({ context, store }: CommandDeps): void {
    if (!sharedLogsOutputChannel) {
        sharedLogsOutputChannel = getOutputChannel();
        context.subscriptions.push(sharedLogsOutputChannel);
    }

    const register = (command: string, handler: (...args: unknown[]) => Promise<void> | void): vscode.Disposable => {
        return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
            try {
                await handler(...args);
            } catch (error) {
                const state = store.getState();
                const message = getUserFriendlyErrorMessage(error, {
                    profile: state.currentProfile,
                    region: state.currentRegion,
                    operation: "Command execution"
                });
                void notify("error", `Command execution failed in ${formatScope(state.currentProfile, state.currentRegion)}: ${message}`);
            }
        });
    };

    const commandHandlers = [
        register("codebuild.switchProfile", async () => switchProfile(context, store)),
        register("codebuild.switchRegion", async () => switchRegionAndReload(context, store)),
        register("codebuild.refresh", async () => {
            clearAwsClientCache();
            store.clearBuildHistoryCache();
            store.clearAllProjectSelections();
            await refreshProfilesAndProjects(context, store, { interactiveFailurePrompt: true });
        }),
        register("codebuild.searchProjects", async () => searchProjects(store)),
        register("codebuild.clearProjectSearch", () => clearProjectSearch(store)),
        register("codebuild.toggleAutoRefresh", () => toggleAutoRefresh(store)),
        register("codebuild.setTemporaryCredentials", async () => setTemporaryCredentials(context, store)),
        register("codebuild.triggerBuild", async (arg?: unknown) => triggerBuild(context, store, arg)),
        register("codebuild.cancelBuild", async (arg?: unknown) => cancelBuild(context, store, arg)),
        register("codebuild.cancelAllBuilds", async () => cancelAllBuilds(context, store)),
        register("codebuild.viewLogs", async (arg?: unknown) => viewLogs(context, store, arg)),
        register("codebuild.selectAllProjects", async () => selectAllProjects(store)),
        register("codebuild.deployAll", async () => deployAll(context, store)),
        register("codebuild.setBranch", async (arg?: unknown) => setBranch(store, arg)),
        register("codebuild.clearAllBranches", async () => clearAllSavedBranches(store)),
        register("codebuild.openTerminal", () => openTerminal())
    ];

    context.subscriptions.push(...commandHandlers);
}

export async function initializeCommandState(context: vscode.ExtensionContext, store: AppStore): Promise<void> {
    await refreshProfilesAndProjects(context, store);

    const state = store.getState();
    if (!state.currentProfile) {
        store.setActiveBuilds([]);
        return;
    }

    try {
        const activeBuilds = await listRecentActiveBuilds(
            state.currentProfile,
            state.currentRegion,
            50,
            { secretStorage: context.secrets }
        );
        store.setActiveBuilds(activeBuilds);
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile: state.currentProfile,
            region: state.currentRegion,
            operation: "Startup build reconciliation"
        });
        logError(`[RECONCILE] ${sanitizeLogValue(message)}`);
    }
}
