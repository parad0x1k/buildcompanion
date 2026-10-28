import * as vscode from "vscode";
import deepEqual from "fast-deep-equal";

export interface AwsProfile {
    name: string;
    type?: "local" | "sso" | "environment" | "temporary";
    region?: string;
}

export interface Project {
    name: string;
    lastBuildStatus?: string;
}

// Comma-separated terms are OR'd together (match any); blank/duplicate terms are ignored.
export function parseProjectSearchTerms(filterText: string): string[] {
    const terms: string[] = [];
    const seen = new Set<string>();

    for (const rawTerm of filterText.split(",")) {
        const term = rawTerm.trim().toLowerCase();
        if (!term || seen.has(term)) {
            continue;
        }

        seen.add(term);
        terms.push(term);
    }

    return terms;
}

export function filterProjectsBySearch(projects: Project[], filterText: string): Project[] {
    const terms = parseProjectSearchTerms(filterText);

    return projects
        .filter((project) => {
            if (terms.length === 0) {
                return true;
            }

            const normalizedName = project.name.toLowerCase();
            return terms.some((term) => normalizedName.includes(term));
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export type BuildStatus = "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "STOPPED" | "FAULT" | "TIMED_OUT";

/** Display preference for build timestamps shown in the tree view: the detected local timezone, or UTC. */
export type BuildTimeDisplayFormat = "local" | "utc";

export interface BuildState {
    id: string;
    projectName: string;
    status: BuildStatus;
    profile: string;
    region: string;
    startTime?: string;
    /** Raw AWS source version (branch/commit/tag) used for this build, when known. */
    sourceVersion?: string;
}

export interface BuildHistoryEntry {
    id: string;
    projectName: string;
    status: BuildStatus;
    profile: string;
    region: string;
    initiator: string;
    sourceVersion: string;
    startedAt?: string;
    endedAt?: string;
    durationSeconds?: number;
}

export interface PendingBuild {
    projectName: string;
    branch?: string;
    profile: string;
    region: string;
    cancellationFenceToken: number;
}

/** A terminal (FAILED/FAULT/TIMED_OUT) build that BuildCompanion itself started, surfaced in the Failed Builds section. */
export interface FailedBuildEntry {
    id: string;
    projectName: string;
    status: BuildStatus;
    profile: string;
    region: string;
    sourceVersion?: string;
    failedAt: string;
}

export interface AppState {
    currentProfile: string | null;
    currentRegion: string;
    autoRefreshEnabled: boolean;
    buildTimeDisplayFormat: BuildTimeDisplayFormat;
    profiles: AwsProfile[];
    regions: string[];
    projectFilter: string;
    projects: Project[];
    activeBuilds: BuildState[];
    buildHistory: Record<string, BuildHistoryEntry[]>;
    buildHistoryLoaded: Record<string, boolean>;
    projectBranches: Record<string, string>;
    selectedProjects: Record<string, boolean>;
    pendingBuilds: PendingBuild[];
    failedBuilds: FailedBuildEntry[];
    destructiveActionBlocks: Record<string, string>;
    scopeCancellationFences: Record<string, number>;
}

const DEFAULT_MAX_HISTORY_ENTRIES_PER_PROJECT = 20;
const MAX_FAILED_BUILDS_PER_SCOPE = 10;

function areStatesEqual(left: AppState, right: AppState): boolean {
    return deepEqual(left, right);
}

function buildHistoryKey(profile: string, region: string, projectName: string): string {
    // JSON tuple encoding avoids delimiter-collision issues in profile/region/project values.
    return JSON.stringify([profile, region, projectName]);
}

function buildHistoryLoadedKey(profile: string, region: string, projectName: string): string {
    // JSON tuple encoding avoids delimiter-collision issues in profile/region/project values.
    return JSON.stringify([profile, region, projectName]);
}

function scopeKey(profile: string, region: string): string {
    // JSON tuple encoding avoids delimiter-collision issues in profile/region values.
    return JSON.stringify([profile.trim(), region.trim()]);
}

function projectScopedKey(projectName: string, profile?: string | null, region?: string): string {
    const normalizedProjectName = projectName.trim();
    const normalizedProfile = profile?.trim();
    const normalizedRegion = region?.trim();

    if (!normalizedProfile || !normalizedRegion) {
        return normalizedProjectName;
    }

    // JSON tuple encoding avoids delimiter-collision issues in profile/region/project values.
    return JSON.stringify([normalizedProfile, normalizedRegion, normalizedProjectName]);
}

function parseProjectScopedKey(key: string): { profile: string; region: string; projectName: string } | undefined {
    try {
        const parsed = JSON.parse(key);
        if (
            Array.isArray(parsed)
            && parsed.length === 3
            && typeof parsed[0] === "string"
            && typeof parsed[1] === "string"
            && typeof parsed[2] === "string"
        ) {
            return {
                profile: parsed[0],
                region: parsed[1],
                projectName: parsed[2]
            };
        }
    } catch {
        // Ignore malformed scoped keys.
    }

    return undefined;
}

function clampHistoryEntries(
    entries: BuildHistoryEntry[],
    maxEntries: number | undefined
): BuildHistoryEntry[] {
    if (!maxEntries || entries.length <= maxEntries) {
        return [...entries];
    }

    return entries.slice(0, maxEntries);
}

export class AppStore {
    private state: AppState;
    private cachedSnapshot: Readonly<AppState> | undefined;
    private readonly onDidRefreshEmitter = new vscode.EventEmitter<void>();
    private batchDepth = 0;
    private hasPendingRefresh = false;
    // Side-channel registry (not rendered, so intentionally outside AppState/refresh) tracking
    // build IDs BuildCompanion itself started, so completion handling can tell those apart from
    // builds merely discovered via startup/profile-switch reconciliation.
    private readonly extensionTriggeredBuildIds = new Set<string>();
    public readonly onDidRefresh = this.onDidRefreshEmitter.event;

    constructor(initialState?: Partial<AppState>) {
        this.state = {
            currentProfile: null,
            currentRegion: "us-east-1",
            autoRefreshEnabled: true,
            buildTimeDisplayFormat: "local",
            profiles: [],
            regions: [],
            projectFilter: "",
            projects: [],
            activeBuilds: [],
            buildHistory: {},
            buildHistoryLoaded: {},
            projectBranches: {},
            selectedProjects: {},
            pendingBuilds: [],
            failedBuilds: [],
            destructiveActionBlocks: {},
            scopeCancellationFences: {},
            ...initialState
        };
    }

    public getState(): Readonly<AppState> {
        if (this.cachedSnapshot) {
            return this.cachedSnapshot;
        }

        const snapshot: AppState = {
            ...this.state,
            profiles: [...this.state.profiles],
            regions: [...this.state.regions],
            projects: [...this.state.projects],
            activeBuilds: [...this.state.activeBuilds],
            buildHistory: Object.fromEntries(
                Object.entries(this.state.buildHistory)
                    .map(([key, entries]) => [key, [...entries]])
            ),
            buildHistoryLoaded: { ...this.state.buildHistoryLoaded },
            projectBranches: { ...this.state.projectBranches },
            selectedProjects: { ...this.state.selectedProjects },
            pendingBuilds: [...this.state.pendingBuilds],
            failedBuilds: [...this.state.failedBuilds],
            destructiveActionBlocks: { ...this.state.destructiveActionBlocks },
            scopeCancellationFences: { ...this.state.scopeCancellationFences }
        };

        this.cachedSnapshot = Object.freeze(snapshot);
        return this.cachedSnapshot;
    }

    public updateState(partial: Partial<AppState>): void {
        const nextState: AppState = {
            ...this.state,
            ...partial
        };

        if (areStatesEqual(this.state, nextState)) {
            return;
        }

        this.state = nextState;
        this.refresh();
    }

    public batchUpdate(update: () => void): void {
        this.batchDepth += 1;
        let threw = false;

        try {
            update();
        } catch (error) {
            threw = true;
            // Invalidate the cached snapshot so the next getState() rebuilds from potentially
            // partially-mutated state rather than returning a stale pre-batch snapshot.
            this.cachedSnapshot = undefined;
            throw error;
        } finally {
            this.batchDepth = Math.max(0, this.batchDepth - 1);
            if (!threw && this.batchDepth === 0 && this.hasPendingRefresh) {
                this.hasPendingRefresh = false;
                this.onDidRefreshEmitter.fire();
            }
        }
    }

    public setCurrentProfile(profile: string | null): void {
        if (this.state.currentProfile === profile) {
            return;
        }

        this.state.currentProfile = profile;
        this.refresh();
    }

    public setCurrentRegion(region: string): void {
        if (this.state.currentRegion === region) {
            return;
        }

        this.state.currentRegion = region;
        this.refresh();
    }

    public setAutoRefreshEnabled(enabled: boolean): void {
        if (this.state.autoRefreshEnabled === enabled) {
            return;
        }

        this.state.autoRefreshEnabled = enabled;
        this.refresh();
    }

    public setBuildTimeDisplayFormat(format: BuildTimeDisplayFormat): void {
        if (this.state.buildTimeDisplayFormat === format) {
            return;
        }

        this.state.buildTimeDisplayFormat = format;
        this.refresh();
    }

    public setProfiles(profiles: AwsProfile[]): void {
        if (deepEqual(this.state.profiles, profiles)) {
            return;
        }

        this.state.profiles = [...profiles];
        this.refresh();
    }

    public setRegions(regions: string[]): void {
        if (deepEqual(this.state.regions, regions)) {
            return;
        }

        this.state.regions = [...regions];
        this.refresh();
    }

    public setProjects(projects: Project[]): void {
        if (deepEqual(this.state.projects, projects)) {
            return;
        }

        this.state.projects = [...projects];
        this.refresh();
    }

    public setProjectFilter(projectFilter: string): void {
        const normalizedFilter = projectFilter.trim();
        if (this.state.projectFilter === normalizedFilter) {
            return;
        }

        this.state.projectFilter = normalizedFilter;
        this.refresh();
    }

    public setActiveBuilds(activeBuilds: BuildState[]): void {
        if (deepEqual(this.state.activeBuilds, activeBuilds)) {
            return;
        }

        this.state.activeBuilds = [...activeBuilds];
        this.refresh();
    }

    public setProjectBuildHistory(
        profile: string,
        region: string,
        projectName: string,
        entries: BuildHistoryEntry[],
        maxEntries: number = DEFAULT_MAX_HISTORY_ENTRIES_PER_PROJECT
    ): void {
        const key = buildHistoryKey(profile, region, projectName);
        const loadedKey = buildHistoryLoadedKey(profile, region, projectName);
        const existing = this.state.buildHistory[key] ?? [];
        const normalizedEntries = clampHistoryEntries(entries, maxEntries);
        const isLoaded = this.state.buildHistoryLoaded[loadedKey] === true;

        if (deepEqual(existing, normalizedEntries) && isLoaded) {
            return;
        }

        this.state.buildHistory[key] = normalizedEntries;
        this.state.buildHistoryLoaded[loadedKey] = true;
        this.refresh();
    }

    public getProjectBuildHistory(profile: string, region: string, projectName: string): BuildHistoryEntry[] {
        const key = buildHistoryKey(profile, region, projectName);
        return [...(this.state.buildHistory[key] ?? [])];
    }

    public isProjectBuildHistoryLoaded(profile: string, region: string, projectName: string): boolean {
        const key = buildHistoryLoadedKey(profile, region, projectName);
        return this.state.buildHistoryLoaded[key] === true;
    }

    public clearBuildHistoryCache(): void {
        if (Object.keys(this.state.buildHistory).length === 0 && Object.keys(this.state.buildHistoryLoaded).length === 0) {
            return;
        }

        this.state.buildHistory = {};
        this.state.buildHistoryLoaded = {};
        this.refresh();
    }

    public setProjectBranch(projectName: string, branch: string): void {
        this.setProjectBranchForScope(projectName, branch);
    }

    public getProjectBranch(projectName: string): string | undefined {
        return this.getProjectBranchForScope(projectName);
    }

    public setProjectBranchForScope(
        projectName: string,
        branch: string,
        profile?: string | null,
        region?: string
    ): void {
        const key = projectScopedKey(projectName, profile, region);
        const normalizedProjectName = projectName.trim();
        const normalizedBranch = branch.trim();
        const existing = this.state.projectBranches[key];

        if (!normalizedBranch) {
            let changed = false;

            if (existing !== undefined) {
                delete this.state.projectBranches[key];
                changed = true;
            }

            // Clear legacy unscoped key when a scoped clear is requested.
            if (key !== normalizedProjectName && this.state.projectBranches[normalizedProjectName] !== undefined) {
                delete this.state.projectBranches[normalizedProjectName];
                changed = true;
            }

            if (!changed) {
                return;
            }

            this.refresh();
            return;
        }

        if (existing === normalizedBranch) {
            return;
        }

        this.state.projectBranches[key] = normalizedBranch;
        this.refresh();
    }

    public getProjectBranchForScope(projectName: string, profile?: string | null, region?: string): string | undefined {
        const scopedKey = projectScopedKey(projectName, profile, region);
        const scopedBranch = this.state.projectBranches[scopedKey];
        if (scopedBranch !== undefined) {
            return scopedBranch;
        }

        // Legacy fallback for unscoped keys from older extension sessions.
        return this.state.projectBranches[projectName.trim()];
    }

    public setProjectBranches(projectBranches: Record<string, string>): void {
        if (deepEqual(this.state.projectBranches, projectBranches)) {
            return;
        }

        this.state.projectBranches = {
            ...projectBranches
        };
        this.refresh();
    }

    public clearAllProjectBranches(): void {
        if (Object.keys(this.state.projectBranches).length === 0) {
            return;
        }

        this.state.projectBranches = {};
        this.refresh();
    }

    public setProjectSelected(projectName: string, profile: string, region: string, selected: boolean): void {
        const key = projectScopedKey(projectName, profile, region);
        const current = this.state.selectedProjects[key] === true;

        if (current === selected) {
            return;
        }

        if (selected) {
            this.state.selectedProjects[key] = true;
        } else {
            delete this.state.selectedProjects[key];
        }

        this.refresh();
    }

    public isProjectSelected(projectName: string, profile: string, region: string): boolean {
        const key = projectScopedKey(projectName, profile, region);
        return this.state.selectedProjects[key] === true;
    }

    public getSelectedProjects(profile: string, region: string): string[] {
        const selectedProjectNames = Object.entries(this.state.selectedProjects)
            .filter(([, selected]) => selected)
            .map(([key]) => parseProjectScopedKey(key))
            .filter((parsed): parsed is { profile: string; region: string; projectName: string } => Boolean(parsed))
            .filter((parsed) => parsed.profile === profile && parsed.region === region)
            .map((parsed) => parsed.projectName);

        return Array.from(new Set(selectedProjectNames));
    }

    public clearProjectSelections(profile: string, region: string): void {
        let changed = false;

        for (const key of Object.keys(this.state.selectedProjects)) {
            const parsed = parseProjectScopedKey(key);
            if (!parsed) {
                continue;
            }

            if (parsed.profile === profile && parsed.region === region) {
                delete this.state.selectedProjects[key];
                changed = true;
            }
        }

        if (!changed) {
            return;
        }

        this.refresh();
    }

    public clearAllProjectSelections(): void {
        if (Object.keys(this.state.selectedProjects).length === 0) {
            return;
        }

        this.state.selectedProjects = {};
        this.refresh();
    }

    public blockDestructiveActionsForScope(profile: string, region: string, reason: string): void {
        const key = scopeKey(profile, region);
        const normalizedReason = reason.trim() || "Unable to validate selected profile scope";

        if (this.state.destructiveActionBlocks[key] === normalizedReason) {
            return;
        }

        this.state.destructiveActionBlocks[key] = normalizedReason;
        this.refresh();
    }

    public clearDestructiveActionBlockForScope(profile: string, region: string): void {
        const key = scopeKey(profile, region);
        if (this.state.destructiveActionBlocks[key] === undefined) {
            return;
        }

        delete this.state.destructiveActionBlocks[key];
        this.refresh();
    }

    public getDestructiveActionBlockForScope(profile: string, region: string): string | undefined {
        const key = scopeKey(profile, region);
        return this.state.destructiveActionBlocks[key];
    }

    public isDestructiveActionBlockedForScope(profile: string, region: string): boolean {
        return this.getDestructiveActionBlockForScope(profile, region) !== undefined;
    }

    public getScopeCancellationFence(profile: string, region: string): number {
        const key = scopeKey(profile, region);
        return this.state.scopeCancellationFences[key] ?? 0;
    }

    public bumpScopeCancellationFence(profile: string, region: string): number {
        const key = scopeKey(profile, region);
        const nextToken = (this.state.scopeCancellationFences[key] ?? 0) + 1;
        this.state.scopeCancellationFences[key] = nextToken;
        this.refresh();
        return nextToken;
    }

    public setPendingBuilds(pendingBuilds: PendingBuild[]): void {
        if (deepEqual(this.state.pendingBuilds, pendingBuilds)) {
            return;
        }

        this.state.pendingBuilds = [...pendingBuilds];
        this.refresh();
    }

    public upsertPendingBuild(pendingBuild: PendingBuild): void {
        const index = this.state.pendingBuilds.findIndex((build) => (
            build.projectName === pendingBuild.projectName
            && build.profile === pendingBuild.profile
            && build.region === pendingBuild.region
        ));

        if (index >= 0) {
            const current = this.state.pendingBuilds[index];
            if (
                current.projectName === pendingBuild.projectName
                && current.profile === pendingBuild.profile
                && current.region === pendingBuild.region
                && current.branch === pendingBuild.branch
                && current.cancellationFenceToken === pendingBuild.cancellationFenceToken
            ) {
                return;
            }

            this.state.pendingBuilds[index] = pendingBuild;
        } else {
            this.state.pendingBuilds.push(pendingBuild);
        }

        this.refresh();
    }

    public getPendingBuild(projectName: string, profile: string, region: string): PendingBuild | undefined {
        return this.state.pendingBuilds.find((build) => (
            build.projectName === projectName
            && build.profile === profile
            && build.region === region
        ));
    }

    public hasPendingBuild(projectName: string, profile: string, region: string): boolean {
        return this.getPendingBuild(projectName, profile, region) !== undefined;
    }

    public removePendingBuildsForScope(profile: string, region: string): void {
        const nextPendingBuilds = this.state.pendingBuilds.filter((build) => !(
            build.profile === profile
            && build.region === region
        ));

        if (nextPendingBuilds.length === this.state.pendingBuilds.length) {
            return;
        }

        this.state.pendingBuilds = nextPendingBuilds;
        this.refresh();
    }

    public removePendingBuild(projectName: string, profile: string, region: string): void {
        const nextPendingBuilds = this.state.pendingBuilds.filter((build) => !(
            build.projectName === projectName
            && build.profile === profile
            && build.region === region
        ));

        if (nextPendingBuilds.length === this.state.pendingBuilds.length) {
            return;
        }

        this.state.pendingBuilds = nextPendingBuilds;
        this.refresh();
    }

    public markBuildAsExtensionTriggered(buildId: string): void {
        this.extensionTriggeredBuildIds.add(buildId);
    }

    public isExtensionTriggeredBuild(buildId: string): boolean {
        return this.extensionTriggeredBuildIds.has(buildId);
    }

    public clearExtensionTriggeredBuild(buildId: string): void {
        this.extensionTriggeredBuildIds.delete(buildId);
    }

    public setFailedBuilds(failedBuilds: FailedBuildEntry[]): void {
        if (deepEqual(this.state.failedBuilds, failedBuilds)) {
            return;
        }

        this.state.failedBuilds = [...failedBuilds];
        this.refresh();
    }

    public getFailedBuilds(profile: string, region: string): FailedBuildEntry[] {
        return this.state.failedBuilds
            .filter((failed) => failed.profile === profile && failed.region === region)
            .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
    }

    public addFailedBuild(entry: FailedBuildEntry): void {
        const sameScope = this.state.failedBuilds.filter((failed) => (
            failed.profile === entry.profile && failed.region === entry.region && failed.id !== entry.id
        ));
        const otherScopes = this.state.failedBuilds.filter((failed) => (
            failed.profile !== entry.profile || failed.region !== entry.region
        ));

        const nextSameScope = [entry, ...sameScope].slice(0, MAX_FAILED_BUILDS_PER_SCOPE);
        this.state.failedBuilds = [...otherScopes, ...nextSameScope];
        this.refresh();
    }

    public removeFailedBuild(buildId: string): void {
        const next = this.state.failedBuilds.filter((failed) => failed.id !== buildId);
        if (next.length === this.state.failedBuilds.length) {
            return;
        }

        this.state.failedBuilds = next;
        this.refresh();
    }

    public clearFailedBuildsForProject(projectName: string, profile: string, region: string): void {
        const next = this.state.failedBuilds.filter((failed) => !(
            failed.projectName === projectName && failed.profile === profile && failed.region === region
        ));

        if (next.length === this.state.failedBuilds.length) {
            return;
        }

        this.state.failedBuilds = next;
        this.refresh();
    }

    public clearFailedBuilds(profile: string, region: string): void {
        const next = this.state.failedBuilds.filter((failed) => !(failed.profile === profile && failed.region === region));
        if (next.length === this.state.failedBuilds.length) {
            return;
        }

        this.state.failedBuilds = next;
        this.refresh();
    }

    public refresh(): void {
        this.cachedSnapshot = undefined;

        if (this.batchDepth > 0) {
            this.hasPendingRefresh = true;
            return;
        }

        this.onDidRefreshEmitter.fire();
    }

    public dispose(): void {
        this.onDidRefreshEmitter.dispose();
    }
}

export function createAppStore(initialState?: Partial<AppState>): AppStore {
    return new AppStore(initialState);
}
