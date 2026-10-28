import * as vscode from "vscode";
import {
    getBuildStatuses,
    isTerminalState,
    startCodeBuild,
    type CodeBuildServiceOptions
} from "../aws/codebuildService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore, BuildState, Project } from "../state/store";
import { logError, logInfo, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, notify } from "../notifications/notifier";
import { retryBuild } from "../commands/retryBuild";
import { persistFailedBuilds } from "../state/failedBuildsPersistence";

const DEFAULT_POLL_INTERVAL_MS = 3000;
const MIN_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 5000;
const POLL_ERROR_NOTIFICATION_COOLDOWN_MS = 30000;
const MAX_IN_PROGRESS_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_STATUS_CHECKS = 6;
const MIN_MAX_CONCURRENT_STATUS_CHECKS = 1;
const MAX_MAX_CONCURRENT_STATUS_CHECKS = 20;
const DIAGNOSTIC_LOG_EVERY_TICKS = 10;
const CIRCUIT_BREAKER_TRIP_AT = 5;
const CIRCUIT_BREAKER_BASE_BACKOFF_MS = 5000;
const CIRCUIT_BREAKER_MAX_BACKOFF_MS = 5 * 60 * 1000;

const ADAPTIVE_POLLING_CONFIG_KEY = "monitor.adaptivePolling";
const MAX_CONCURRENT_STATUS_CHECKS_CONFIG_KEY = "monitor.maxConcurrentStatusChecks";
const PERFORMANCE_DIAGNOSTICS_ENABLED_KEY = "performanceDiagnostics.enabled";

function formatBranchForNotification(branch?: string): string {
    const normalizedBranch = branch?.trim();
    return normalizedBranch && normalizedBranch.length > 0 ? normalizedBranch : "default source version";
}

function formatSanitizedScope(profile: string, region: string): string {
    return `${sanitizeLogValue(profile, "profile")}/${sanitizeLogValue(region, "region")}`;
}

function formatSanitizedProjectScope(projectName: string, profile: string, region: string): string {
    return `${sanitizeLogValue(projectName)} (${formatSanitizedScope(profile, region)})`;
}

export class BuildMonitor implements vscode.Disposable {
    private readonly pollIntervalMs: number;
    private timer: NodeJS.Timeout | null = null;
    private currentPollIntervalMs: number | null = null;
    private isTickRunning = false;
    private readonly notifiedBuildIds = new Set<string>();
    private readonly lastPollingErrorAtByBuildId = new Map<string, number>();
    private readonly consecutivePollFailuresByScopeKey = new Map<string, number>();
    private readonly scopePollBackoffUntilMs = new Map<string, number>();
    private readonly storeRefreshSubscription: vscode.Disposable;
    private readonly configurationSubscription: vscode.Disposable;
    private adaptivePollingEnabled = true;
    private maxConcurrentStatusChecks = DEFAULT_MAX_CONCURRENT_STATUS_CHECKS;
    private diagnosticsEnabled = false;
    private diagnosticsTickCounter = 0;
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: AppStore,
        pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
    ) {
        this.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, pollIntervalMs));
        this.loadSettings();

        this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration(`codebuild.${ADAPTIVE_POLLING_CONFIG_KEY}`)
                || event.affectsConfiguration(`codebuild.${MAX_CONCURRENT_STATUS_CHECKS_CONFIG_KEY}`)
                || event.affectsConfiguration(`codebuild.${PERFORMANCE_DIAGNOSTICS_ENABLED_KEY}`)
            ) {
                this.loadSettings();
                this.reconcilePollingState();
            }
        });

        this.storeRefreshSubscription = this.store.onDidRefresh(() => {
            this.reconcilePollingState();
        });
    }

    public start(): void {
        this.reconcilePollingState();
    }

    public stop(): void {
        this.stopTimer();
    }

    public dispose(): void {
        this.disposed = true;
        this.configurationSubscription.dispose();
        this.storeRefreshSubscription.dispose();
        this.stop();
    }

    private loadSettings(): void {
        const config = vscode.workspace.getConfiguration("codebuild");

        this.adaptivePollingEnabled = config.get<boolean>(ADAPTIVE_POLLING_CONFIG_KEY, true);
        this.diagnosticsEnabled = config.get<boolean>(PERFORMANCE_DIAGNOSTICS_ENABLED_KEY, false);

        const configuredMaxChecks = Number(config.get<number>(
            MAX_CONCURRENT_STATUS_CHECKS_CONFIG_KEY,
            DEFAULT_MAX_CONCURRENT_STATUS_CHECKS
        ));

        if (!Number.isFinite(configuredMaxChecks)) {
            this.maxConcurrentStatusChecks = DEFAULT_MAX_CONCURRENT_STATUS_CHECKS;
            return;
        }

        const normalized = Math.floor(configuredMaxChecks);
        this.maxConcurrentStatusChecks = Math.min(
            MAX_MAX_CONCURRENT_STATUS_CHECKS,
            Math.max(MIN_MAX_CONCURRENT_STATUS_CHECKS, normalized)
        );
    }

    private stopTimer(): void {
        if (!this.timer) {
            this.currentPollIntervalMs = null;
            return;
        }

        clearInterval(this.timer);
        this.timer = null;
        this.currentPollIntervalMs = null;
    }

    private shouldPoll(state: Readonly<ReturnType<AppStore["getState"]>>): boolean {
        return state.autoRefreshEnabled && state.activeBuilds.length > 0;
    }

    private resolvePollIntervalMs(state: Readonly<ReturnType<AppStore["getState"]>>): number {
        if (!this.adaptivePollingEnabled) {
            return this.pollIntervalMs;
        }

        const activeBuildCount = state.activeBuilds.length;
        if (activeBuildCount <= 2) {
            return this.pollIntervalMs;
        }

        if (activeBuildCount <= 8) {
            return Math.min(MAX_POLL_INTERVAL_MS, this.pollIntervalMs + 500);
        }

        if (activeBuildCount <= 20) {
            return Math.min(MAX_POLL_INTERVAL_MS, this.pollIntervalMs + 1000);
        }

        return MAX_POLL_INTERVAL_MS;
    }

    private maybeLogDiagnostics(summary: string): void {
        if (!this.diagnosticsEnabled) {
            return;
        }

        logInfo(`[PERF] ${summary}`);
    }

    private reconcilePollingState(): void {
        const state = this.store.getState();
        if (!this.shouldPoll(state)) {
            this.stopTimer();
            return;
        }

        const nextPollIntervalMs = this.resolvePollIntervalMs(state);
        if (this.timer && this.currentPollIntervalMs === nextPollIntervalMs) {
            return;
        }

        if (this.timer) {
            clearInterval(this.timer);
        }

        this.currentPollIntervalMs = nextPollIntervalMs;
        this.timer = setInterval(() => {
            void this.tick();
        }, nextPollIntervalMs);

        void this.tick();
    }

    private shouldNotifyPollingError(buildId: string): boolean {
        const now = Date.now();
        const previous = this.lastPollingErrorAtByBuildId.get(buildId);

        if (previous !== undefined && now - previous < POLL_ERROR_NOTIFICATION_COOLDOWN_MS) {
            return false;
        }

        this.lastPollingErrorAtByBuildId.set(buildId, now);
        return true;
    }

    private getServiceOptions(): CodeBuildServiceOptions {
        return {
            secretStorage: this.context.secrets
        };
    }

    private isStaleInProgressBuild(build: BuildState): boolean {
        if (build.status !== "IN_PROGRESS" || !build.startTime) {
            return false;
        }

        const startedAtMs = new Date(build.startTime).getTime();
        if (!Number.isFinite(startedAtMs)) {
            return false;
        }

        return Date.now() - startedAtMs > MAX_IN_PROGRESS_AGE_MS;
    }

    private updateProjectStatusesFromBuilds(builds: BuildState[]): void {
        const state = this.store.getState();
        if (!state.currentProfile) {
            return;
        }

        const statusByProject = new Map<string, string>();
        for (const build of builds) {
            if (build.profile === state.currentProfile && build.region === state.currentRegion) {
                statusByProject.set(build.projectName, build.status);
            }
        }

        if (statusByProject.size === 0) {
            return;
        }

        const nextProjects: Project[] = state.projects.map((project) => {
            const status = statusByProject.get(project.name);
            if (!status) {
                return project;
            }

            return {
                ...project,
                lastBuildStatus: status
            };
        });

        const hasProjectStatusChanges = nextProjects.some((project, index) => {
            const current = state.projects[index];
            return !current || current.lastBuildStatus !== project.lastBuildStatus || current.name !== project.name;
        });

        if (!hasProjectStatusChanges) {
            return;
        }

        this.store.setProjects(nextProjects);
    }

    private notifyCompletion(build: BuildState): void {
        if (this.notifiedBuildIds.has(build.id)) {
            return;
        }

        this.notifiedBuildIds.add(build.id);
        const branchLabel = formatBranchForNotification(build.sourceVersion);
        const wasExtensionTriggered = this.store.isExtensionTriggeredBuild(build.id);
        this.store.clearExtensionTriggeredBuild(build.id);

        if (build.status === "SUCCEEDED") {
            const successMessage = `Deployment completed for ${formatProjectScope(build.projectName, build.profile, build.region)} using ${branchLabel}`;
            void notify("success", successMessage);

            // Only touch persisted state when this project actually had a failed entry to clear.
            const hadFailedEntries = this.store.getFailedBuilds(build.profile, build.region)
                .some((failed) => failed.projectName === build.projectName);
            if (hadFailedEntries) {
                this.store.clearFailedBuildsForProject(build.projectName, build.profile, build.region);
                void persistFailedBuilds(this.context, this.store.getState().failedBuilds);
            }
            return;
        }

        if (build.status === "STOPPED") {
            const stoppedMessage = `Deployment stopped for ${formatProjectScope(build.projectName, build.profile, build.region)} using ${branchLabel}`;
            logInfo(
                `[BUILD] Deployment stopped for ${formatSanitizedProjectScope(build.projectName, build.profile, build.region)} (buildId: ${sanitizeLogValue(build.id, "buildId")}, status: ${build.status})`
            );
            void notify("warning", stoppedMessage);
            return;
        }

        if (
            build.status === "FAILED"
            || build.status === "FAULT"
            || build.status === "TIMED_OUT"
        ) {
            const failureMessage = `Deployment failed for ${formatProjectScope(build.projectName, build.profile, build.region)} using ${branchLabel}`;
            logError(
                `[BUILD] Deployment failed for ${formatSanitizedProjectScope(build.projectName, build.profile, build.region)} (buildId: ${sanitizeLogValue(build.id, "buildId")}, status: ${build.status})`
            );

            if (wasExtensionTriggered) {
                this.store.addFailedBuild({
                    id: build.id,
                    projectName: build.projectName,
                    status: build.status,
                    profile: build.profile,
                    region: build.region,
                    sourceVersion: build.sourceVersion,
                    failedAt: new Date().toISOString()
                });
                void persistFailedBuilds(this.context, this.store.getState().failedBuilds);
            }

            // Lets the user restart the build directly from the notification, without opening Build History.
            void notify("error", failureMessage, { actions: ["Retry Build"] }).then((selection) => {
                if (selection !== "Retry Build") {
                    return;
                }

                void retryBuild(this.context, this.store, {
                    id: build.id,
                    projectName: build.projectName,
                    status: build.status,
                    profile: build.profile,
                    region: build.region,
                    sourceVersion: build.sourceVersion
                });
            });
        }
    }

    private cleanupNotifiedBuildIds(activeBuilds: BuildState[]): void {
        const activeIds = new Set(activeBuilds.map((build) => build.id));
        for (const buildId of this.notifiedBuildIds) {
            if (!activeIds.has(buildId)) {
                this.notifiedBuildIds.delete(buildId);
            }
        }

        for (const buildId of this.lastPollingErrorAtByBuildId.keys()) {
            if (!activeIds.has(buildId)) {
                this.lastPollingErrorAtByBuildId.delete(buildId);
            }
        }

        // Clean up circuit-breaker state for scopes that no longer have active builds.
        const activeScopeKeys = new Set(
            activeBuilds.map((build) => JSON.stringify([build.profile, build.region]))
        );
        for (const scopeKey of this.consecutivePollFailuresByScopeKey.keys()) {
            if (!activeScopeKeys.has(scopeKey)) {
                this.consecutivePollFailuresByScopeKey.delete(scopeKey);
                this.scopePollBackoffUntilMs.delete(scopeKey);
            }
        }
    }

    private async runQueuedBuildIfAny(completedBuild: BuildState): Promise<BuildState | undefined> {
        const pending = this.store.getPendingBuild(
            completedBuild.projectName,
            completedBuild.profile,
            completedBuild.region
        );

        if (!pending) {
            return undefined;
        }

        const currentFenceToken = this.store.getScopeCancellationFence(pending.profile, pending.region);
        if (pending.cancellationFenceToken !== currentFenceToken) {
            this.store.removePendingBuild(pending.projectName, pending.profile, pending.region);
            logInfo(
                `[BUILD] Skipping queued build for ${formatSanitizedProjectScope(pending.projectName, pending.profile, pending.region)} due to cancellation fence mismatch.`
            );
            return undefined;
        }

        try {
            const startedBuild = await startCodeBuild(
                pending.profile,
                pending.region,
                pending.projectName,
                pending.branch,
                this.getServiceOptions()
            );

            this.store.removePendingBuild(pending.projectName, pending.profile, pending.region);
            this.store.markBuildAsExtensionTriggered(startedBuild.id);

            const branchLabel = formatBranchForNotification(pending.branch);
            void notify("info", `Deployment triggered for ${formatProjectScope(pending.projectName, pending.profile, pending.region)} using ${branchLabel}`);

            void notify("success", `Build started for ${formatProjectScope(pending.projectName, pending.profile, pending.region)} using ${branchLabel}`, {
                target: "status",
                timeoutMs: 3000
            });

            return startedBuild;
        } catch (error) {
            const message = getUserFriendlyErrorMessage(error, {
                profile: pending.profile,
                region: pending.region,
                operation: "Starting queued build"
            });
            const failureMessage = `Build trigger failed for ${formatProjectScope(pending.projectName, pending.profile, pending.region)}`;
            logError(
                `[BUILD] Build trigger failed for ${formatSanitizedProjectScope(pending.projectName, pending.profile, pending.region)}: ${sanitizeLogValue(message)}`
            );
            void notify("error", failureMessage);

            return undefined;
        }
    }

    private async pollScopeBuilds(
        scopeKey: string,
        scopedBuilds: Array<{ build: BuildState; index: number }>,
        results: Array<{ original: BuildState; resolved: BuildState | null; failed: boolean }>
    ): Promise<void> {
        const [firstScopedBuild] = scopedBuilds;
        if (!firstScopedBuild) {
            return;
        }

        const profile = firstScopedBuild.build.profile;
        const region = firstScopedBuild.build.region;

        // Circuit breaker: skip this scope if it is in backoff after repeated failures.
        const backoffUntil = this.scopePollBackoffUntilMs.get(scopeKey);
        if (backoffUntil !== undefined && Date.now() < backoffUntil) {
            for (const { build, index } of scopedBuilds) {
                results[index] = { original: build, resolved: build, failed: false };
            }
            return;
        }

        for (const { build } of scopedBuilds) {
            if (this.isStaleInProgressBuild(build) && this.shouldNotifyPollingError(build.id)) {
                const staleMessage = `Build appears stale but is still being monitored for ${formatProjectScope(build.projectName, build.profile, build.region)}`;
                logInfo(
                    `[BUILD] Build appears stale but is still being monitored for ${formatSanitizedProjectScope(build.projectName, build.profile, build.region)} (buildId: ${sanitizeLogValue(build.id, "buildId")})`
                );
                void notify("warning", staleMessage);
            }
        }

        try {
            const statuses = await getBuildStatuses(
                profile,
                region,
                scopedBuilds.map(({ build }) => build.id),
                this.getServiceOptions()
            );

            // Reset circuit breaker on success.
            this.consecutivePollFailuresByScopeKey.delete(scopeKey);
            this.scopePollBackoffUntilMs.delete(scopeKey);

            for (const { build, index } of scopedBuilds) {
                const latest = statuses.get(build.id) ?? null;
                if (!latest) {
                    logInfo(
                        `[BUILD] Build ${sanitizeLogValue(build.id, "buildId")} no longer exists in AWS for ${formatSanitizedProjectScope(build.projectName, build.profile, build.region)}. Removing from monitor.`
                    );
                }

                results[index] = {
                    original: build,
                    resolved: latest,
                    failed: false
                };
            }
        } catch (error) {
            // Increment circuit-breaker failure counter for this scope.
            const prevFailures = this.consecutivePollFailuresByScopeKey.get(scopeKey) ?? 0;
            const nextFailures = prevFailures + 1;
            this.consecutivePollFailuresByScopeKey.set(scopeKey, nextFailures);

            if (nextFailures >= CIRCUIT_BREAKER_TRIP_AT) {
                const exponent = nextFailures - CIRCUIT_BREAKER_TRIP_AT;
                const backoffMs = Math.min(
                    CIRCUIT_BREAKER_MAX_BACKOFF_MS,
                    CIRCUIT_BREAKER_BASE_BACKOFF_MS * (2 ** exponent)
                );
                this.scopePollBackoffUntilMs.set(scopeKey, Date.now() + backoffMs);
                logInfo(
                    `[BUILD] Circuit breaker tripped for ${formatSanitizedScope(profile, region)} after ${nextFailures} consecutive failures. Pausing polling for ${Math.round(backoffMs / 1000)}s.`
                );
            }

            for (const { build, index } of scopedBuilds) {
                const message = getUserFriendlyErrorMessage(error, {
                    profile: build.profile,
                    region: build.region,
                    operation: "Polling build status"
                });
                logError(
                    `[BUILD] Build monitor polling failed for ${sanitizeLogValue(build.id, "buildId")} in ${formatSanitizedScope(build.profile, build.region)}: ${sanitizeLogValue(message)}`
                );

                if (this.shouldNotifyPollingError(build.id)) {
                    const pollFailureMessage = `Build status polling failed for ${formatProjectScope(build.projectName, build.profile, build.region)}`;
                    logError(
                        `[BUILD] Build status polling failed for ${formatSanitizedProjectScope(build.projectName, build.profile, build.region)}: ${sanitizeLogValue(message)}`
                    );
                    void notify("error", pollFailureMessage);
                }

                results[index] = {
                    original: build,
                    resolved: build,
                    failed: true
                };
            }
        }
    }

    private async pollBuilds(activeBuilds: BuildState[]): Promise<Array<{
        original: BuildState;
        resolved: BuildState | null;
        failed: boolean;
    }>> {
        if (activeBuilds.length === 0) {
            return [];
        }

        const results: Array<{
            original: BuildState;
            resolved: BuildState | null;
            failed: boolean;
        }> = new Array(activeBuilds.length);

        const buildsByScope = new Map<string, Array<{ build: BuildState; index: number }>>();
        for (let index = 0; index < activeBuilds.length; index += 1) {
            const build = activeBuilds[index];
            // JSON tuple encoding avoids delimiter-collision issues in profile/region values.
            const scopeKey = JSON.stringify([build.profile, build.region]);
            const scoped = buildsByScope.get(scopeKey) ?? [];
            scoped.push({ build, index });
            buildsByScope.set(scopeKey, scoped);
        }

        // Poll scopes in parallel, bounded by maxConcurrentStatusChecks.
        const scopeEntries = [...buildsByScope.entries()];
        const chunkSize = Math.max(1, this.maxConcurrentStatusChecks);
        for (let i = 0; i < scopeEntries.length; i += chunkSize) {
            const chunk = scopeEntries.slice(i, i + chunkSize);
            await Promise.all(
                chunk.map(([scopeKey, scopedBuilds]) =>
                    this.pollScopeBuilds(scopeKey, scopedBuilds, results)
                )
            );
        }

        return results;
    }

    private async tick(): Promise<void> {
        if (this.isTickRunning) {
            return;
        }

        this.isTickRunning = true;
        const tickStart = Date.now();

        try {
            if (this.disposed) {
                return;
            }

            const stateAtTickStart = this.store.getState();
            if (!this.shouldPoll(stateAtTickStart)) {
                return;
            }

            const nextActiveBuilds: BuildState[] = [];
            const allObservedBuilds: BuildState[] = [];
            const polledBuilds = await this.pollBuilds(stateAtTickStart.activeBuilds);

            for (const polled of polledBuilds) {
                if (!polled.resolved) {
                    continue;
                }

                allObservedBuilds.push(polled.resolved);

                if (isTerminalState(polled.resolved.status)) {
                    this.notifyCompletion(polled.resolved);
                    const queuedBuild = await this.runQueuedBuildIfAny(polled.resolved);
                    if (queuedBuild) {
                        nextActiveBuilds.push(queuedBuild);
                        allObservedBuilds.push(queuedBuild);
                    }
                    continue;
                }

                nextActiveBuilds.push(polled.resolved);
            }

            const polledIds = new Set(stateAtTickStart.activeBuilds.map((build) => build.id));
            const latestState = this.store.getState();
            const concurrentActiveBuilds = latestState.activeBuilds.filter((build) => !polledIds.has(build.id));
            const mergedActiveBuilds: BuildState[] = [
                ...nextActiveBuilds,
                ...concurrentActiveBuilds.filter((build) => !nextActiveBuilds.some((nextBuild) => nextBuild.id === build.id))
            ];

            const hasActiveBuildChanges = mergedActiveBuilds.length !== latestState.activeBuilds.length
                || mergedActiveBuilds.some((build, index) => {
                    const current = latestState.activeBuilds[index];
                    return !current
                        || current.id !== build.id
                        || current.projectName !== build.projectName
                        || current.status !== build.status
                        || current.profile !== build.profile
                        || current.region !== build.region
                        || current.startTime !== build.startTime;
                });

            this.cleanupNotifiedBuildIds(mergedActiveBuilds);
            if (!this.disposed) {
                this.store.batchUpdate(() => {
                    if (hasActiveBuildChanges) {
                        this.store.setActiveBuilds(mergedActiveBuilds);
                    }

                    this.updateProjectStatusesFromBuilds(allObservedBuilds);
                });
            }
        } finally {
            this.diagnosticsTickCounter += 1;
            if (this.diagnosticsTickCounter >= DIAGNOSTIC_LOG_EVERY_TICKS) {
                this.diagnosticsTickCounter = 0;
                const activeBuildCount = this.store.getState().activeBuilds.length;
                const elapsedMs = Date.now() - tickStart;
                this.maybeLogDiagnostics(
                    `monitor.tick=${elapsedMs}ms activeBuilds=${activeBuildCount} intervalMs=${this.currentPollIntervalMs ?? this.pollIntervalMs} concurrency=${this.maxConcurrentStatusChecks}`
                );
            }

            this.isTickRunning = false;
        }
    }
}
