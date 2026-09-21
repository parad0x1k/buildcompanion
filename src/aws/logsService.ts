import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
    getBuildLogsLocation,
    getBuildStatus,
    isTerminalState,
    type CodeBuildServiceOptions
} from "./codebuildService";
import { createCloudWatchLogsClient } from "./clientFactory";
import { getUserFriendlyErrorMessage } from "./errorHandling";
import { extractErrorSummary } from "./errorExtractor";
import type { BuildStatus } from "../state/store";
import { logError, logInfo, logSection, sanitizeLogValue } from "../logging/outputChannelManager";

const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_MAX_EMPTY_POLLS = 4;
const DEFAULT_RECENT_LINE_BUFFER_SIZE = 500;
const DEFAULT_LOG_LOCATION_TIMEOUT_MS = 120000;
const MAX_RECOVERABLE_POLL_ERRORS = 5;
const MAX_RECOVERABLE_BACKOFF_MS = 10000;

const activeStreams = new Map<string, AbortController>();

export class LogStreamingCancelledError extends Error {
    constructor(message: string = "Log streaming cancelled") {
        super(message);
        this.name = "LogStreamingCancelledError";
    }
}

export type LogsServiceOptions = CodeBuildServiceOptions & {
    pollIntervalMs?: number;
    maxEmptyPolls?: number;
    recentLineBufferSize?: number;
    logLocationTimeoutMs?: number;
    onFailureSummary?: (summary: string) => void;
    signal?: AbortSignal;
};

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            resolve();
        }, delayMs);

        const onAbort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };

        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function buildStreamKey(profile: string, region: string, buildId: string): string {
    // JSON tuple encoding avoids delimiter-collision issues in profile/region/buildId values.
    return JSON.stringify([profile, region, buildId]);
}

function formatSanitizedScope(profile: string, region: string): string {
    return `${sanitizeLogValue(profile, "profile")}/${sanitizeLogValue(region, "region")}`;
}

function sanitizeBuildIdentifier(buildId: string): string {
    return sanitizeLogValue(buildId, "buildId");
}

function isLogsNotReadyError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }

    const name = (error as { name?: string }).name;
    return name === "ResourceNotFoundException" || name === "InvalidParameterException";
}

function isRecoverablePollingError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }

    const name = (error as { name?: string }).name;
    if (!name) {
        return false;
    }

    return name === "ThrottlingException"
        || name === "TooManyRequestsException"
        || name === "RequestTimeout"
        || name === "TimeoutError"
        || name === "NetworkingError"
        || name === "ServiceUnavailableException";
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) {
        return;
    }

    throw new LogStreamingCancelledError();
}

function createLinkedAbortController(signal?: AbortSignal): AbortController {
    const controller = new AbortController();

    if (!signal) {
        return controller;
    }

    signal.addEventListener("abort", () => controller.abort(), { once: true });
    if (signal.aborted) {
        controller.abort();
    }

    return controller;
}

export function isLogStreamingCancellationError(error: unknown): boolean {
    if (error instanceof LogStreamingCancelledError) {
        return true;
    }

    return Boolean(error instanceof Error && error.name === "AbortError");
}

export function stopActiveLogStream(): void {
    if (activeStreams.size === 0) {
        return;
    }

    for (const controller of activeStreams.values()) {
        controller.abort();
    }
    activeStreams.clear();
}

export function disposeLogsStreaming(): void {
    stopActiveLogStream();
}

function appendLogMessage(timestamp: number | undefined, message: string): void {
    const prefix = timestamp ? `[${new Date(timestamp).toISOString()}] ` : "";
    const lines = message.replace(/\r\n/g, "\n").split("\n");

    for (const line of lines) {
        logInfo(`[LOGS] ${prefix}${line}`);
    }
}

function pushRecentLogLine(buffer: string[], line: string, maxSize: number): void {
    buffer.push(line);
    if (buffer.length > maxSize) {
        buffer.shift();
    }
}

async function resolveLogLocation(
    profile: string,
    region: string,
    buildId: string,
    signal: AbortSignal,
    options?: LogsServiceOptions
): Promise<{ logGroupName: string; logStreamName: string; status: BuildStatus }> {
    const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = Math.max(5000, options?.logLocationTimeoutMs ?? DEFAULT_LOG_LOCATION_TIMEOUT_MS);
    const startedAtMs = Date.now();

    while (true) {
        throwIfAborted(signal);

        if (Date.now() - startedAtMs > timeoutMs) {
            throw new Error(`Timed out while waiting for CloudWatch logs for build ${buildId}`);
        }

        const location = await getBuildLogsLocation(profile, region, buildId, {
            secretStorage: options?.secretStorage,
            signal
        });

        if (!location) {
            throw new Error(`Build ${buildId} was not found`);
        }

        if (location.logGroupName && location.logStreamName) {
            return {
                logGroupName: location.logGroupName,
                logStreamName: location.logStreamName,
                status: location.status
            };
        }

        if (isTerminalState(location.status)) {
            throw new Error("CloudWatch log stream is unavailable for this build");
        }

        logInfo(
            `[LOGS] Waiting for CloudWatch logs to become available for build ${sanitizeBuildIdentifier(buildId)} (${formatSanitizedScope(profile, region)})...`
        );
        await sleep(pollIntervalMs, signal);
    }
}

export async function streamBuildLogs(
    profile: string,
    region: string,
    buildId: string,
    options?: LogsServiceOptions
): Promise<void> {
    const normalizedProfile = profile.trim();
    const normalizedRegion = region.trim();
    const normalizedBuildId = buildId.trim();

    if (!normalizedProfile) {
        throw new Error("AWS profile is required to stream logs");
    }

    if (!normalizedRegion) {
        throw new Error("AWS region is required to stream logs");
    }

    if (!normalizedBuildId) {
        throw new Error("Build ID is required to stream logs");
    }

    const streamKey = buildStreamKey(normalizedProfile, normalizedRegion, normalizedBuildId);
    const existingStreamController = activeStreams.get(streamKey);
    if (existingStreamController) {
        existingStreamController.abort();
        activeStreams.delete(streamKey);
    }

    const controller = createLinkedAbortController(options?.signal);
    activeStreams.set(streamKey, controller);

    const signal = controller.signal;
    const sanitizedBuildId = sanitizeBuildIdentifier(normalizedBuildId);
    const sanitizedScope = formatSanitizedScope(normalizedProfile, normalizedRegion);

    const pollIntervalMs = Math.max(2000, Math.min(3000, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    const maxEmptyPolls = options?.maxEmptyPolls ?? DEFAULT_MAX_EMPTY_POLLS;
    const recentLineBufferSize = Math.min(500, Math.max(50, options?.recentLineBufferSize ?? DEFAULT_RECENT_LINE_BUFFER_SIZE));

    try {
        throwIfAborted(signal);

        logSection(`[LOGS] Build ${sanitizedBuildId}`);
        logInfo(`[LOGS] Streaming logs for build ${sanitizedBuildId} (${sanitizedScope})`);

        const location = await resolveLogLocation(
            normalizedProfile,
            normalizedRegion,
            normalizedBuildId,
            signal,
            options
        );

        logInfo(`[LOGS] Log group: ${sanitizeLogValue(location.logGroupName)}`);
        logInfo(`[LOGS] Log stream: ${sanitizeLogValue(location.logStreamName, "buildId")}`);

        const logsClient = await createCloudWatchLogsClient(normalizedProfile, normalizedRegion, {
            secretStorage: options?.secretStorage
        });

        let buildStatus: BuildStatus = location.status;
        let nextForwardToken: string | undefined;
        let emptyPolls = 0;
        const recentLogLines: string[] = [];
        let consecutiveRecoverableErrors = 0;

        while (true) {
            throwIfAborted(signal);

            try {
                const response = await logsClient.send(new GetLogEventsCommand({
                    logGroupName: location.logGroupName,
                    logStreamName: location.logStreamName,
                    // Tail-first avoids expensive full-history backfill for long-running builds.
                    startFromHead: false,
                    nextToken: nextForwardToken
                }), {
                    abortSignal: signal
                });
                consecutiveRecoverableErrors = 0;

                const events = response.events ?? [];
                const previousToken = nextForwardToken;
                nextForwardToken = response.nextForwardToken;

                if (events.length > 0) {
                    for (const event of events) {
                        const message = event.message ?? "";
                        appendLogMessage(event.timestamp, message);

                        const normalizedLines = message.replace(/\r\n/g, "\n").split("\n");
                        for (const line of normalizedLines) {
                            const trimmed = line.trim();
                            if (!trimmed) {
                                continue;
                            }
                            pushRecentLogLine(recentLogLines, trimmed, recentLineBufferSize);
                        }
                    }
                    emptyPolls = 0;
                } else {
                    emptyPolls += 1;
                }

                const tokenDidNotAdvance = previousToken !== undefined && nextForwardToken === previousToken;
                if (tokenDidNotAdvance || events.length === 0) {
                    const latestBuild = await getBuildStatus(
                        normalizedProfile,
                        normalizedRegion,
                        normalizedBuildId,
                        { secretStorage: options?.secretStorage, signal }
                    );

                    if (latestBuild) {
                        buildStatus = latestBuild.status;
                    }

                    if (isTerminalState(buildStatus) && tokenDidNotAdvance) {
                        break;
                    }

                    if (isTerminalState(buildStatus) && emptyPolls >= maxEmptyPolls) {
                        break;
                    }

                    await sleep(pollIntervalMs, signal);
                }
            } catch (error) {
                if (isLogStreamingCancellationError(error)) {
                    throw new LogStreamingCancelledError();
                }

                if (isLogsNotReadyError(error)) {
                    const latestBuild = await getBuildStatus(
                        normalizedProfile,
                        normalizedRegion,
                        normalizedBuildId,
                        { secretStorage: options?.secretStorage, signal }
                    );

                    if (latestBuild) {
                        buildStatus = latestBuild.status;
                    }

                    if (isTerminalState(buildStatus)) {
                        break;
                    }

                    await sleep(pollIntervalMs, signal);
                    continue;
                }

                if (isRecoverablePollingError(error) && consecutiveRecoverableErrors < MAX_RECOVERABLE_POLL_ERRORS) {
                    consecutiveRecoverableErrors += 1;
                    logInfo(
                        `[LOGS] Recoverable log polling error for build ${sanitizedBuildId} (${sanitizedScope}) (${consecutiveRecoverableErrors}/${MAX_RECOVERABLE_POLL_ERRORS}), retrying...`
                    );
                    const jitterMs = Math.floor(Math.random() * 250);
                    const backoffMs = Math.min(
                        MAX_RECOVERABLE_BACKOFF_MS,
                        pollIntervalMs * (2 ** Math.max(0, consecutiveRecoverableErrors - 1))
                    );
                    await sleep(backoffMs + jitterMs, signal);
                    continue;
                }

                throw error;
            }
        }

        if (buildStatus === "FAILED") {
            const summaryLines = extractErrorSummary(recentLogLines, {
                maxInputLines: recentLineBufferSize,
                maxSummaryLines: 5
            });

            if (summaryLines.length > 0) {
                const summary = summaryLines.join("\n");

                logInfo(`[LOGS] Failure summary for build ${sanitizedBuildId} (${sanitizedScope}):`);
                for (const line of summaryLines) {
                    logInfo(`[LOGS] - ${line}`);
                }

                options?.onFailureSummary?.(summary);
            }
        }

        logInfo(`[LOGS] Finished streaming logs for build ${sanitizedBuildId}`);
    } catch (error) {
        if (isLogStreamingCancellationError(error)) {
            logInfo(`[LOGS] Streaming cancelled for build ${sanitizedBuildId}`);
            throw new LogStreamingCancelledError();
        }

        const message = getUserFriendlyErrorMessage(error, {
            profile: normalizedProfile,
            region: normalizedRegion,
            operation: "Streaming build logs"
        });

        logError(`[LOGS] Streaming build logs failed for ${sanitizedBuildId} (${sanitizedScope}): ${sanitizeLogValue(message)}`);

        throw new Error(message);
    } finally {
        const currentController = activeStreams.get(streamKey);
        if (currentController === controller) {
            activeStreams.delete(streamKey);
        }
    }
}
