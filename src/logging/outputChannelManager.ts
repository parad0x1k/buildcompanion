import * as vscode from "vscode";

const CHANNEL_NAME = "BuildCompanion";
const DEFAULT_MAX_OUTPUT_LINES = 8000;
const MIN_MAX_OUTPUT_LINES = 1000;
const MIN_RETAINED_OUTPUT_LINES = 200;
const RETAINED_OUTPUT_RATIO = 0.5;
const MAX_OUTPUT_LINES_SETTING_KEY = "logging.maxOutputLines";
const VERBOSE_LOGGING_SETTING_KEY = "logging.verbose";

let sharedOutputChannel: vscode.OutputChannel | undefined;
let appendedLineCount = 0;
let recentLinesBuffer: string[] = [];

export type LogSanitizationKind = "generic" | "profile" | "region" | "buildId";

function isVerboseLoggingEnabled(): boolean {
    return vscode.workspace.getConfiguration("codebuild").get<boolean>(VERBOSE_LOGGING_SETTING_KEY, false);
}

function normalizeLogValue(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value)
        .replace(/\r\n/g, " ")
        // Strip all C0 control characters (including ESC/\x1b used for ANSI color codes) and DEL
        // to prevent log forging or terminal-rendering tricks via untrusted identifiers.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function sanitizeLogValue(value: unknown, kind: LogSanitizationKind = "generic"): string {
    const normalized = normalizeLogValue(value);
    if (!normalized) {
        return "unknown";
    }

    if (isVerboseLoggingEnabled()) {
        return normalized;
    }

    if (kind === "profile") {
        return "<profile-redacted>";
    }

    if (kind === "region") {
        return "<region-redacted>";
    }

    if (kind === "buildId") {
        return "<build-id-redacted>";
    }

    return normalized;
}

function getConfiguredMaxOutputLines(): number {
    const configured = Number(vscode.workspace.getConfiguration("codebuild").get<number>(
        MAX_OUTPUT_LINES_SETTING_KEY,
        DEFAULT_MAX_OUTPUT_LINES
    ));

    if (!Number.isFinite(configured)) {
        return DEFAULT_MAX_OUTPUT_LINES;
    }

    const normalized = Math.floor(configured);
    if (normalized <= 0) {
        return 0;
    }

    return Math.max(MIN_MAX_OUTPUT_LINES, normalized);
}

function appendManagedLine(line: string): void {
    const channel = getOutputChannel();
    const maxOutputLines = getConfiguredMaxOutputLines();

    if (maxOutputLines > 0) {
        recentLinesBuffer.push(line);
        if (recentLinesBuffer.length > maxOutputLines) {
            recentLinesBuffer.shift();
        }
    }

    channel.appendLine(line);
    appendedLineCount += 1;

    if (maxOutputLines <= 0 || appendedLineCount <= maxOutputLines) {
        return;
    }

    const retainCount = Math.min(
        maxOutputLines,
        Math.max(MIN_RETAINED_OUTPUT_LINES, Math.floor(maxOutputLines * RETAINED_OUTPUT_RATIO))
    );
    const retainedLines = recentLinesBuffer.slice(-retainCount);

    channel.clear();
    appendedLineCount = 0;
    channel.appendLine(`[INFO] Output history reached ${maxOutputLines} lines and was truncated. Retaining the most recent ${retainedLines.length} lines.`);
    appendedLineCount += 1;

    for (const retainedLine of retainedLines) {
        channel.appendLine(retainedLine);
        appendedLineCount += 1;
    }

    recentLinesBuffer = [...retainedLines];
}

export function getOutputChannel(): vscode.OutputChannel {
    if (!sharedOutputChannel) {
        sharedOutputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
    }

    return sharedOutputChannel;
}

export function logInfo(message: string): void {
    appendManagedLine(`[INFO] ${message}`);
}

export function logError(message: string): void {
    appendManagedLine(`[ERROR] ${message}`);
}

export function logSection(title: string): void {
    const normalizedTitle = title.trim() || "Section";
    appendManagedLine(`[INFO] ===== ${normalizedTitle} =====`);
}

/**
 * Disposes the shared output channel and clears the in-memory recent-lines buffer.
 * Called from `deactivate()` so module-scope state does not survive across
 * `Developer: Reload Window` invocations within a reused extension host process.
 */
export function disposeOutputChannel(): void {
    recentLinesBuffer = [];
    appendedLineCount = 0;
    if (sharedOutputChannel) {
        sharedOutputChannel.dispose();
        sharedOutputChannel = undefined;
    }
}
