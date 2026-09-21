import * as vscode from "vscode";
import type { AppStore, BuildHistoryEntry, BuildState, Project } from "../state/store";
import { logError, sanitizeLogValue } from "../logging/outputChannelManager";

type RootNodeKind =
    | "settingsSection"
    | "profileSelector"
    | "credentialsSelector"
    | "regionSelector"
    | "autoRefreshToggle"
    | "projectsSection"
    | "buildHistorySection"
    | "activeBuildsSection";

export type TreeNode =
    | { kind: RootNodeKind }
    | { kind: "project"; project: Project }
    | { kind: "projectHistoryGroup"; project: Project }
    | { kind: "historyBuild"; build: BuildHistoryEntry }
    | { kind: "activeBuild"; build: BuildState }
    | { kind: "message"; label: string; description?: string; icon?: vscode.ThemeIcon; command?: vscode.Command };

export class CodeBuildTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    private readonly refreshSubscription: vscode.Disposable;
    private readonly activeBuildSeenAt = new Map<string, number>();
    private readonly loadingHistoryKeys = new Set<string>();
    private lastCanSelectMultipleProjects: boolean | undefined;
    private lastHasSavedBranches: boolean | undefined;
    private disposed = false;
    private projectVisibilityCache:
        | {
            // Keyed on the frozen snapshot reference returned by store.getState(), which
            // remains stable between state changes (the store caches it in cachedSnapshot).
            // Using the snapshot object reference instead of state.projects avoids a cache
            // miss on every render caused by getState() always spreading projects into a new array.
            snapshotRef: Readonly<ReturnType<AppStore["getState"]>>;
            filterText: string;
            visibleProjects: Project[];
            canSelectVisibleProjects: boolean;
            shouldShowProjectCheckboxes: boolean;
        }
        | undefined;

    constructor(
        private readonly store: AppStore,
        private readonly loadBuildHistoryForProject: (
            profile: string,
            region: string,
            projectName: string
        ) => Promise<void>
    ) {
        this.refreshSubscription = this.store.onDidRefresh(() => this.refresh());
    }

    public refresh(): void {
        if (this.disposed) {
            return;
        }
        this.onDidChangeTreeDataEmitter.fire();
    }

    private filterProjects(projects: Project[], filterText: string): Project[] {
        const filter = filterText.toLowerCase();
        return projects
            .filter((project) => !filter || project.name.toLowerCase().includes(filter))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    private getProjectVisibility(state: ReturnType<AppStore["getState"]>): {
        visibleProjects: Project[];
        canSelectVisibleProjects: boolean;
        shouldShowProjectCheckboxes: boolean;
    } {
        const filterText = state.projectFilter ?? "";
        const cached = this.projectVisibilityCache;

        if (cached && cached.snapshotRef === state && cached.filterText === filterText) {
            return cached;
        }

        const visibleProjects = this.filterProjects(state.projects, filterText);
        const hasFilter = filterText.trim().length > 0;
        const canSelectVisibleProjects = visibleProjects.length > 0 && (!hasFilter || visibleProjects.length > 1);
        const shouldShowProjectCheckboxes = !hasFilter || visibleProjects.length > 1;

        const nextCache = {
            snapshotRef: state,
            filterText,
            visibleProjects,
            canSelectVisibleProjects,
            shouldShowProjectCheckboxes
        };

        this.projectVisibilityCache = nextCache;
        return nextCache;
    }

    private getVisibleProjects(state: ReturnType<AppStore["getState"]>): Project[] {
        return this.getProjectVisibility(state).visibleProjects;
    }

    private shouldShowProjectCheckboxes(state: ReturnType<AppStore["getState"]>): boolean {
        return this.getProjectVisibility(state).shouldShowProjectCheckboxes;
    }

    private canSelectVisibleProjects(state: ReturnType<AppStore["getState"]>): boolean {
        return this.getProjectVisibility(state).canSelectVisibleProjects;
    }

    private syncViewContexts(state: ReturnType<AppStore["getState"]>): void {
        const canSelectVisibleProjects = this.canSelectVisibleProjects(state);
        if (this.lastCanSelectMultipleProjects !== canSelectVisibleProjects) {
            this.lastCanSelectMultipleProjects = canSelectVisibleProjects;
            void vscode.commands.executeCommand("setContext", "codebuild.canSelectMultipleProjects", canSelectVisibleProjects);
        }

        const hasSavedBranches = Object.keys(state.projectBranches).length > 0;
        if (this.lastHasSavedBranches !== hasSavedBranches) {
            this.lastHasSavedBranches = hasSavedBranches;
            void vscode.commands.executeCommand("setContext", "codebuild.hasSavedBranches", hasSavedBranches);
        }
    }

    private hasBuildHistoryLoadedForProject(
        state: ReturnType<AppStore["getState"]>,
        projectName: string
    ): boolean {
        if (!state.currentProfile) {
            return false;
        }

        return this.store.isProjectBuildHistoryLoaded(state.currentProfile, state.currentRegion, projectName);
    }

    private buildHistoryLoadingKey(profile: string, region: string, projectName: string): string {
        // JSON tuple encoding avoids delimiter-collision issues in profile/region/project values.
        return JSON.stringify([profile, region, projectName]);
    }

    /**
     * Returns a status-aware icon. The `variant` controls the default fallback icon and
     * whether the STOPPED status shows a distinct icon (only relevant for history builds).
     */
    private getStatusIcon(
        status: string | undefined,
        variant: "project" | "activeBuild" | "historyBuild" = "project"
    ): vscode.ThemeIcon {
        if (status === "SUCCEEDED") {
            return new vscode.ThemeIcon("check");
        }

        if (status === "FAILED" || status === "FAULT" || status === "TIMED_OUT") {
            return new vscode.ThemeIcon("error");
        }

        if (status === "IN_PROGRESS") {
            return new vscode.ThemeIcon("sync~spin");
        }

        if (status === "STOPPED" && variant === "historyBuild") {
            return new vscode.ThemeIcon("circle-slash");
        }

        if (variant === "historyBuild") {
            return new vscode.ThemeIcon("circle-outline");
        }

        return new vscode.ThemeIcon("repo");
    }

    private truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }

        return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
    }

    private formatHistoryCompletionLabel(build: BuildHistoryEntry): string | undefined {
        const normalizedEndedAt = build.endedAt?.trim();
        if (!normalizedEndedAt) {
            return undefined;
        }

        const endedAtDate = new Date(normalizedEndedAt);
        const endedAtText = Number.isFinite(endedAtDate.getTime())
            ? endedAtDate.toLocaleString()
            : normalizedEndedAt;

        if (build.status === "SUCCEEDED") {
            return `Completed: ${endedAtText}`;
        }

        if (build.status === "FAILED" || build.status === "FAULT" || build.status === "TIMED_OUT") {
            return `Failed: ${endedAtText}`;
        }

        if (build.status === "STOPPED") {
            return `Stopped: ${endedAtText}`;
        }

        return `Updated: ${endedAtText}`;
    }

    private formatDuration(ms?: number): string {
        if (ms === undefined) {
            return "Duration unavailable";
        }

        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes === 0) {
            return `${seconds}s`;
        }

        if (seconds === 0) {
            return `${minutes}m`;
        }

        return `${minutes}m ${seconds}s`;
    }

    public getTreeItem(element: TreeNode): vscode.TreeItem {
        switch (element.kind) {
            case "settingsSection": {
                const item = new vscode.TreeItem("Settings", vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = new vscode.ThemeIcon("folder");
                item.id = "codebuild.settingsSection";
                return item;
            }
            case "profileSelector": {
                const state = this.store.getState();
                const profile = state.currentProfile ?? "Not selected";
                const item = new vscode.TreeItem("Profile", vscode.TreeItemCollapsibleState.None);
                item.description = profile;
                item.iconPath = new vscode.ThemeIcon("account");
                item.id = "codebuild.profileSelector";
                item.command = {
                    command: "codebuild.switchProfile",
                    title: "Switch Profile"
                };
                return item;
            }
            case "credentialsSelector": {
                const item = new vscode.TreeItem("Credentials", vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon("key");
                item.id = "codebuild.credentialsSelector";
                item.command = {
                    command: "codebuild.setTemporaryCredentials",
                    title: "Set Temporary Credentials"
                };
                return item;
            }
            case "regionSelector": {
                const state = this.store.getState();
                const item = new vscode.TreeItem("Region", vscode.TreeItemCollapsibleState.None);
                item.description = state.currentRegion;
                item.iconPath = new vscode.ThemeIcon("globe");
                item.id = "codebuild.regionSelector";
                item.command = {
                    command: "codebuild.switchRegion",
                    title: "Switch Region"
                };
                return item;
            }
            case "autoRefreshToggle": {
                const state = this.store.getState();
                const isEnabled = state.autoRefreshEnabled;
                const item = new vscode.TreeItem(
                    `Auto Refresh: ${isEnabled ? "ON" : "OFF"}`,
                    vscode.TreeItemCollapsibleState.None
                );
                item.iconPath = new vscode.ThemeIcon(isEnabled ? "sync" : "debug-pause");
                item.id = "codebuild.autoRefreshToggle";
                item.command = {
                    command: "codebuild.toggleAutoRefresh",
                    title: "Toggle Auto Refresh"
                };
                return item;
            }
            case "projectsSection": {
                const state = this.store.getState();
                const item = new vscode.TreeItem("Projects", vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = new vscode.ThemeIcon("folder");
                item.id = "codebuild.projectsSection";
                item.contextValue = "projectsRoot";

                if (state.currentProfile) {
                    const selectedCount = this.store.getSelectedProjects(state.currentProfile, state.currentRegion).length;
                    if (selectedCount > 0) {
                        item.description = `${selectedCount} selected`;
                    }
                }

                return item;
            }
            case "activeBuildsSection": {
                const item = new vscode.TreeItem("Active Builds", vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = new vscode.ThemeIcon("folder");
                item.id = "codebuild.activeBuildsSection";
                return item;
            }
            case "buildHistorySection": {
                const item = new vscode.TreeItem("Build History", vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = new vscode.ThemeIcon("folder");
                item.id = "codebuild.buildHistorySection";
                return item;
            }
            case "project": {
                const state = this.store.getState();
                const item = new vscode.TreeItem(element.project.name, vscode.TreeItemCollapsibleState.None);
                item.description = element.project.lastBuildStatus ?? "No builds have been run yet";
                item.iconPath = this.getStatusIcon(element.project.lastBuildStatus, "project");
                item.tooltip = `${element.project.name} - ${element.project.lastBuildStatus ?? "No builds have been run yet"}`;
                item.contextValue = "project";
                item.id = `codebuild.project.${element.project.name}`;

                if (state.currentProfile && this.shouldShowProjectCheckboxes(state)) {
                    const selected = this.store.isProjectSelected(
                        element.project.name,
                        state.currentProfile,
                        state.currentRegion
                    );

                    item.checkboxState = {
                        state: selected
                            ? vscode.TreeItemCheckboxState.Checked
                            : vscode.TreeItemCheckboxState.Unchecked,
                        tooltip: "Select project for deployment"
                    };
                }

                return item;
            }
            case "projectHistoryGroup": {
                const state = this.store.getState();
                if (!state.currentProfile) {
                    return new vscode.TreeItem(element.project.name, vscode.TreeItemCollapsibleState.Collapsed);
                }

                const historyEntries = this.store.getProjectBuildHistory(
                    state.currentProfile,
                    state.currentRegion,
                    element.project.name
                );
                const isHistoryLoaded = this.hasBuildHistoryLoadedForProject(state, element.project.name);
                const loadingKey = this.buildHistoryLoadingKey(
                    state.currentProfile,
                    state.currentRegion,
                    element.project.name
                );
                const isLoading = this.loadingHistoryKeys.has(loadingKey);

                const item = new vscode.TreeItem(element.project.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = !isHistoryLoaded
                    ? isLoading
                        ? "Loading..."
                        : "Expand to load build history"
                    : historyEntries.length > 0
                        ? `${historyEntries.length} builds`
                        : "No builds";
                item.iconPath = new vscode.ThemeIcon("output");
                item.contextValue = "codebuildProjectHistory";
                item.id = `codebuild.projectHistory.${element.project.name}`;
                return item;
            }
            case "historyBuild": {
                const branch = element.build.sourceVersion?.trim() || "unknown";
                const initiator = element.build.initiator?.trim() || "unknown";
                const completionLabel = this.formatHistoryCompletionLabel(element.build);
                const item = new vscode.TreeItem(
                    `${branch} (${initiator})`,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = completionLabel;
                item.iconPath = this.getStatusIcon(element.build.status, "historyBuild");
                item.tooltip = [
                    `Build ID: ${element.build.id}`,
                    `Branch: ${branch}`,
                    `Triggered by: ${initiator}`,
                    `Status: ${element.build.status}`,
                    completionLabel ?? "Completed/failed time: unavailable"
                ].join("\n");
                item.contextValue = "build";
                item.id = `codebuild.historyBuild.${element.build.id}`;
                return item;
            }
            case "activeBuild": {
                const seenAt = this.activeBuildSeenAt.get(element.build.id);
                const startedAtMs = element.build.startTime ? new Date(element.build.startTime).getTime() : undefined;
                const elapsedMs = startedAtMs !== undefined && Number.isFinite(startedAtMs)
                    ? Math.max(0, Date.now() - startedAtMs)
                    : seenAt !== undefined
                        ? Date.now() - seenAt
                        : undefined;
                const durationText = this.formatDuration(elapsedMs);
                const item = new vscode.TreeItem(
                    `${element.build.projectName} • ${durationText}`,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = `${element.build.profile}/${element.build.region} • ${element.build.status}`;
                item.iconPath = this.getStatusIcon(element.build.status, "activeBuild");
                item.tooltip = [
                    `Project: ${element.build.projectName}`,
                    `Profile: ${element.build.profile}`,
                    `Region: ${element.build.region}`,
                    `Build ID: ${element.build.id}`,
                    `Status: ${element.build.status}`,
                    `Elapsed: ${durationText}`
                ].join("\n");
                item.contextValue = element.build.status === "IN_PROGRESS" ? "buildInProgress" : "build";
                item.id = `codebuild.activeBuild.${element.build.id}`;
                return item;
            }
            case "message": {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.description = element.description;
                item.iconPath = element.icon ?? new vscode.ThemeIcon("info");
                item.command = element.command;
                return item;
            }
        }
    }

    public getChildren(element?: TreeNode): TreeNode[] {
        const state = this.store.getState();
        this.syncViewContexts(state);

        if (!element) {
            return [
                { kind: "settingsSection" },
                { kind: "projectsSection" },
                { kind: "activeBuildsSection" },
                { kind: "buildHistorySection" }
            ];
        }

        if (element.kind === "settingsSection") {
            return [
                { kind: "profileSelector" },
                { kind: "regionSelector" },
                { kind: "autoRefreshToggle" },
                { kind: "credentialsSelector" }
            ];

        }

        if (element.kind === "projectsSection") {
            if (state.profiles.length === 0) {
                return [
                    {
                        kind: "message",
                        label: "No AWS profiles configured",
                        description: "Run aws configure or aws sso login",
                        icon: new vscode.ThemeIcon("warning")
                    },
                    {
                        kind: "message",
                        label: "Open Terminal",
                        description: "Set up AWS credentials",
                        icon: new vscode.ThemeIcon("terminal"),
                        command: {
                            command: "codebuild.openTerminal",
                            title: "Open AWS Setup Terminal"
                        }
                    }
                ];
            }

            if (state.projects.length === 0) {
                return [
                    {
                        kind: "message",
                        label: "No CodeBuild projects found",
                        icon: new vscode.ThemeIcon("inbox")
                    }
                ];
            }

            const filteredProjects = this.getVisibleProjects(state);

            if (filteredProjects.length === 0) {
                return [
                    {
                        kind: "message",
                        label: "No CodeBuild projects found",
                        icon: new vscode.ThemeIcon("inbox")
                    }
                ];
            }

            return filteredProjects.map((project) => ({
                kind: "project",
                project
            }));
        }

        if (element.kind === "activeBuildsSection") {
            if (state.activeBuilds.length === 0) {
                this.activeBuildSeenAt.clear();
                return [
                    {
                        kind: "message",
                        label: "No active builds",
                        icon: new vscode.ThemeIcon("circle-slash")
                    }
                ];
            }

            const activeIds = new Set(state.activeBuilds.map((build) => build.id));
            for (const buildId of this.activeBuildSeenAt.keys()) {
                if (!activeIds.has(buildId)) {
                    this.activeBuildSeenAt.delete(buildId);
                }
            }

            for (const build of state.activeBuilds) {
                if (!this.activeBuildSeenAt.has(build.id)) {
                    this.activeBuildSeenAt.set(build.id, Date.now());
                }
            }

            return state.activeBuilds.map((build) => ({
                kind: "activeBuild",
                build
            }));
        }

        if (element.kind === "buildHistorySection") {
            if (state.projects.length === 0) {
                return [
                    {
                        kind: "message",
                        label: "No CodeBuild projects found",
                        icon: new vscode.ThemeIcon("inbox")
                    }
                ];
            }

            const filteredProjects = this.getVisibleProjects(state);

            if (filteredProjects.length === 0) {
                return [
                    {
                        kind: "message",
                        label: "No CodeBuild projects found",
                        icon: new vscode.ThemeIcon("inbox")
                    }
                ];
            }

            return filteredProjects.map((project) => ({
                kind: "projectHistoryGroup",
                project
            }));
        }

        if (element.kind === "projectHistoryGroup") {
            if (!state.currentProfile) {
                return [
                    {
                        kind: "message",
                        label: "Select an AWS profile",
                        icon: new vscode.ThemeIcon("warning")
                    }
                ];
            }

            if (!this.hasBuildHistoryLoadedForProject(state, element.project.name)) {
                const loadingKey = this.buildHistoryLoadingKey(
                    state.currentProfile,
                    state.currentRegion,
                    element.project.name
                );

                if (!this.loadingHistoryKeys.has(loadingKey)) {
                    this.loadingHistoryKeys.add(loadingKey);
                    void this.loadBuildHistoryForProject(
                        state.currentProfile,
                        state.currentRegion,
                        element.project.name
                    ).catch((error: unknown) => {
                        logError(
                            `[HISTORY] Failed to load build history for ${sanitizeLogValue(element.project.name)}: ${sanitizeLogValue(String(error))}`
                        );
                    }).finally(() => {
                        this.loadingHistoryKeys.delete(loadingKey);
                        this.refresh();
                    });
                }

                return [
                    {
                        kind: "message",
                        label: "Loading build history...",
                        icon: new vscode.ThemeIcon("sync~spin")
                    }
                ];
            }

            const historyEntries = this.store.getProjectBuildHistory(
                state.currentProfile,
                state.currentRegion,
                element.project.name
            );

            if (historyEntries.length === 0) {
                return [
                    {
                        kind: "message",
                        label: "No build history found",
                        icon: new vscode.ThemeIcon("circle-slash")
                    }
                ];
            }

            return historyEntries.map((build) => ({
                kind: "historyBuild",
                build
            }));
        }

        return [];
    }

    public dispose(): void {
        this.disposed = true;
        this.refreshSubscription.dispose();
        this.onDidChangeTreeDataEmitter.dispose();
        this.activeBuildSeenAt.clear();
        this.loadingHistoryKeys.clear();
        this.projectVisibilityCache = undefined;
    }
}
