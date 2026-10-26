import * as vscode from "vscode";
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
const MAX_LOGS_NOT_READY_RETRIES = 5;
const LOGS_NOT_READY_RETRY_DELAY_MS = 1500;
const DEFAULT_MAX_FULL_LOG_LINES = 50000;
const MIN_MAX_FULL_LOG_LINES = 1000;
// Hard ceiling on the number of GetLogEvents pages fetched for a single "full log" request,
// independent of the configurable line cap, so a pathological log stream can't loop forever.
const MAX_FULL_LOG_FETCH_PAGES = 5000;

// Matches ANSI/VT100 escape sequences (CSI "ESC[...<letter>", OSC "ESC]...BEL/ST", and other
// common two-character escape sequences). Build tools frequently emit these for colorized
// terminal output; left intact they render as stray control-character glyphs ("random
// characters") in the plain-text log viewer, so they're stripped before display.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?(?:\u0007|\u001B\u005C)|(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-ntqry=><~])/g;

// Any other C0 control character that isn't part of a recognized escape sequence (stray ESC
// bytes, bell, form-feed, etc.) also renders as an unreadable glyph; drop those too. Tabs are
// preserved since build tools legitimately use them for indentation.
// eslint-disable-next-line no-control-regex
const RESIDUAL_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function collapseCarriageReturnOverwrites(line: string): string {
    // Progress bars/spinners (docker pull, npm, pip, apt-get, etc.) repeatedly overwrite the
    // same terminal line using a bare "\r" instead of "\n". A plain-text viewer can't redraw in
    // place, so keep only the text after the final "\r" - the same content a real terminal
    // would be showing once all the overwrites settle.
    const lastCarriageReturnIndex = line.lastIndexOf("\r");
    return lastCarriageReturnIndex === -1 ? line : line.slice(lastCarriageReturnIndex + 1);
}

/**
 * Cleans a raw CloudWatch log event message for display: collapses carriage-return
 * progress-bar overwrites and strips ANSI color/cursor escape codes and other stray control
 * characters, so colorized or progress-reporting build tool output reads as plain, legible text
 * instead of garbled control characters.
 */
export function sanitizeLogMessageForDisplay(message: string): string {
    return message
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => collapseCarriageReturnOverwrites(line))
        .map((line) => line.replace(ANSI_ESCAPE_PATTERN, ""))
        .map((line) => line.replace(RESIDUAL_CONTROL_CHAR_PATTERN, ""))
        .join("\n");
}

function getConfiguredMaxFullLogLines(): number {
    const configured = Number(
        vscode.workspace.getConfiguration("codebuild").get<number>("logsViewer.maxFullLogLines", DEFAULT_MAX_FULL_LOG_LINES)
    );

    if (!Number.isFinite(configured)) {
        return DEFAULT_MAX_FULL_LOG_LINES;
    }

    return Math.max(MIN_MAX_FULL_LOG_LINES, Math.floor(configured));
}

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
    /** Called with newly formatted log lines as they arrive, in addition to the shared output channel. */
    onLogLines?: (lines: string[]) => void;
    /** Called once streaming ends normally (build reached a terminal state), with its final status. */
    onComplete?: (status: BuildStatus) => void;
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

/**
 * Prefixes each (already-sanitized) line of a log event with its ISO timestamp. Mirroring to
 * the shared output channel is optional since a bulk "full log" fetch can produce tens of
 * thousands of lines that shouldn't flood the extension's diagnostic output channel.
 */
function formatLogLines(
    timestamp: number | undefined,
    sanitizedMessage: string,
    options?: { mirrorToOutputChannel?: boolean }
): string[] {
    const prefix = timestamp ? `[${new Date(timestamp).toISOString()}] ` : "";
    const lines = sanitizedMessage.split("\n");
    const formattedLines: string[] = [];
    const mirrorToOutputChannel = options?.mirrorToOutputChannel ?? true;

    for (const line of lines) {
        const formattedLine = `${prefix}${line}`;
        if (mirrorToOutputChannel) {
            logInfo(`[LOGS] ${formattedLine}`);
        }
        formattedLines.push(formattedLine);
    }

    return formattedLines;
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
                    const viewerLines: string[] = [];
                    for (const event of events) {
                        const rawMessage = event.message ?? "";
                        const sanitizedMessage = sanitizeLogMessageForDisplay(rawMessage);
                        viewerLines.push(...formatLogLines(event.timestamp, sanitizedMessage));

                        for (const line of sanitizedMessage.split("\n")) {
                            const trimmed = line.trim();
                            if (!trimmed) {
                                continue;
                            }
                            pushRecentLogLine(recentLogLines, trimmed, recentLineBufferSize);
                        }
                    }
                    // Forwarded once per poll response (not per line/event) so a large page of
                    // CloudWatch events collapses into a single viewer update.
                    options?.onLogLines?.(viewerLines);
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

        options?.onComplete?.(buildStatus);
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

export type FetchFullBuildLogOptions = CodeBuildServiceOptions & {
    logLocationTimeoutMs?: number;
    /** Safety cap on total lines fetched; defaults to the `codebuild.logsViewer.maxFullLogLines` setting. */
    maxLines?: number;
    /** Called with each newly fetched page's formatted lines, in fetch order. */
    onLines?: (lines: string[]) => void;
    /** Called after each page with the cumulative number of lines fetched so far. */
    onProgress?: (totalLines: number) => void;
};

export type FetchFullBuildLogResult = {
    status: BuildStatus;
    totalLines: number;
    truncated: boolean;
};

/**
 * Fetches a build's entire available CloudWatch log history (from the beginning, not just the
 * recent tail shown by `streamBuildLogs`) as a single readable snapshot, paginating through
 * `GetLogEvents` until it catches up to the latest data or a safety limit is reached. Unlike
 * `streamBuildLogs`, this does not keep polling for new data afterward - for a still-running
 * build it simply returns everything emitted so far.
 */
export async function fetchFullBuildLog(
    profile: string,
    region: string,
    buildId: string,
    options?: FetchFullBuildLogOptions
): Promise<FetchFullBuildLogResult> {
    const normalizedProfile = profile.trim();
    const normalizedRegion = region.trim();
    const normalizedBuildId = buildId.trim();

    if (!normalizedProfile) {
        throw new Error("AWS profile is required to fetch build logs");
    }

    if (!normalizedRegion) {
        throw new Error("AWS region is required to fetch build logs");
    }

    if (!normalizedBuildId) {
        throw new Error("Build ID is required to fetch build logs");
    }

    const signal = options?.signal ?? new AbortController().signal;
    const sanitizedBuildId = sanitizeBuildIdentifier(normalizedBuildId);
    const sanitizedScope = formatSanitizedScope(normalizedProfile, normalizedRegion);

    try {
        throwIfAborted(signal);
        logInfo(`[LOGS] Fetching full log history for build ${sanitizedBuildId} (${sanitizedScope})`);

        const location = await resolveLogLocation(normalizedProfile, normalizedRegion, normalizedBuildId, signal, options);
        const logsClient = await createCloudWatchLogsClient(normalizedProfile, normalizedRegion, {
            secretStorage: options?.secretStorage
        });

        // Only the configuration-derived default is floored to MIN_MAX_FULL_LOG_LINES (matching
        // the setting's declared minimum); an explicit caller-provided override is trusted as-is.
        const maxLines = options?.maxLines ?? getConfiguredMaxFullLogLines();

        let nextToken: string | undefined;
        let totalLines = 0;
        let truncated = false;
        let pageCount = 0;
        let consecutiveRecoverableErrors = 0;
        let logsNotReadyRetries = 0;

        while (true) {
            throwIfAborted(signal);

            let response;
            try {
                response = await logsClient.send(new GetLogEventsCommand({
                    logGroupName: location.logGroupName,
                    logStreamName: location.logStreamName,
                    startFromHead: true,
                    nextToken
                }), { abortSignal: signal });
                consecutiveRecoverableErrors = 0;
            } catch (error) {
                if (isLogStreamingCancellationError(error)) {
                    throw new LogStreamingCancelledError();
                }

                if (isLogsNotReadyError(error) && logsNotReadyRetries < MAX_LOGS_NOT_READY_RETRIES) {
                    logsNotReadyRetries += 1;
                    await sleep(LOGS_NOT_READY_RETRY_DELAY_MS, signal);
                    continue;
                }

                if (isRecoverablePollingError(error) && consecutiveRecoverableErrors < MAX_RECOVERABLE_POLL_ERRORS) {
                    consecutiveRecoverableErrors += 1;
                    const jitterMs = Math.floor(Math.random() * 250);
                    const backoffMs = Math.min(
                        MAX_RECOVERABLE_BACKOFF_MS,
                        500 * (2 ** Math.max(0, consecutiveRecoverableErrors - 1))
                    );
                    await sleep(backoffMs + jitterMs, signal);
                    continue;
                }

                throw error;
            }

            pageCount += 1;
            const events = response.events ?? [];
            const previousToken = nextToken;
            nextToken = response.nextForwardToken;

            if (events.length > 0) {
                const pageLines: string[] = [];
                for (const event of events) {
                    const sanitizedMessage = sanitizeLogMessageForDisplay(event.message ?? "");
                    pageLines.push(...formatLogLines(event.timestamp, sanitizedMessage, { mirrorToOutputChannel: false }));
                }

                if (totalLines + pageLines.length > maxLines) {
                    const allowedCount = Math.max(0, maxLines - totalLines);
                    if (allowedCount > 0) {
                        options?.onLines?.(pageLines.slice(0, allowedCount));
                        totalLines += allowedCount;
                    }
                    truncated = true;
                    break;
                }

                options?.onLines?.(pageLines);
                totalLines += pageLines.length;
                options?.onProgress?.(totalLines);
            }

            const tokenDidNotAdvance = previousToken !== undefined && nextToken === previousToken;
            if (tokenDidNotAdvance || events.length === 0) {
                break;
            }

            if (pageCount >= MAX_FULL_LOG_FETCH_PAGES) {
                truncated = true;
                break;
            }
        }

        const latestBuild = await getBuildStatus(normalizedProfile, normalizedRegion, normalizedBuildId, {
            secretStorage: options?.secretStorage,
            signal
        });

        logInfo(
            `[LOGS] Finished fetching full log history for build ${sanitizedBuildId} (${totalLines} line(s)${truncated ? ", truncated" : ""})`
        );

        return {
            status: latestBuild?.status ?? location.status,
            totalLines,
            truncated
        };
    } catch (error) {
        if (isLogStreamingCancellationError(error)) {
            logInfo(`[LOGS] Full log fetch cancelled for build ${sanitizedBuildId}`);
            throw new LogStreamingCancelledError();
        }

        const message = getUserFriendlyErrorMessage(error, {
            profile: normalizedProfile,
            region: normalizedRegion,
            operation: "Fetching full build log"
        });

        logError(`[LOGS] Full log fetch failed for ${sanitizedBuildId} (${sanitizedScope}): ${sanitizeLogValue(message)}`);

        throw new Error(message);
    }
}
