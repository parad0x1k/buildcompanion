import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { logError, logInfo, sanitizeLogValue } from "../logging/outputChannelManager";
import { renderBuildLogsPanelHtml } from "./buildLogsPanelHtml";

/** `viewType` of every build log panel; also the value `activeWebviewPanelId` takes in `when` clauses. */
export const BUILD_LOGS_PANEL_VIEW_TYPE = "codebuild.buildLogs";

// Keeps the panel responsive for long-running builds that emit very large volumes of output;
// older lines are dropped once this cap is exceeded (see getMaxViewerLines()).
const DEFAULT_MAX_VIEWER_LINES = 10000;
const MIN_MAX_VIEWER_LINES = 500;

// How long a finished log session's lines stay in memory (and in its panel) before they are
// dropped. Counted from when the stream ends, not from when it started, so a long build is
// never cut off mid-stream.
const DEFAULT_TTL_MINUTES = 15;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 1440;

// Coalesces bursts of appended lines (one CloudWatch page can hold thousands) into one
// postMessage to the webview instead of one per batch.
const FLUSH_INTERVAL_MS = 150;

const MOVE_EDITOR_TO_NEW_WINDOW_COMMAND = "workbench.action.moveEditorToNewWindow";

export type BuildLogsMode = "tail" | "full";

/**
 * - `streaming`: a stream/fetch is attached and writing lines.
 * - `complete`: the stream reached the end of the build's log; lines are kept until the TTL.
 * - `stopped`: the stream was cancelled before the end.
 * - `failed`: the stream errored.
 * - `expired`: the TTL elapsed and the lines were dropped; the panel offers a reload.
 */
export type BuildLogsPhase = "streaming" | "complete" | "stopped" | "failed" | "expired";

export type BuildLogsOpenIn = "window" | "editor";

export type BuildLogsHeader = {
    projectName: string;
    profile: string;
    region: string;
    buildId: string;
    mode: BuildLogsMode;
};

export type BuildLogsSnapshot = {
    header: BuildLogsHeader;
    lines: string[];
    truncatedCount: number;
    phase: BuildLogsPhase;
    footer?: string;
    buildStatus?: string;
    expiresAtMs?: number;
    hasPanel: boolean;
    poppedOut: boolean;
};

/**
 * What a log command holds on to while streaming. Every method is a no-op once the session it
 * was issued for has been reset (reload, re-open after expiry) or discarded (panel closed), so a
 * late callback from an old stream can never write into a newer session's panel.
 */
export interface BuildLogsSessionHandle {
    readonly key: string;
    isCurrent(): boolean;
    registerCanceller(cancel: () => void): void;
    appendLines(lines: string[]): void;
    finish(phase: Exclude<BuildLogsPhase, "streaming" | "expired">, footer?: string, buildStatus?: string): void;
}

/** `reused` means an existing streaming/finished session was revealed and nothing should be fetched. */
export type BuildLogsOpenResult = { handle: BuildLogsSessionHandle; reused: boolean };

export type BuildLogsPanelManagerOptions = {
    getTtlMs?: () => number;
    getMaxLines?: () => number;
    getOpenIn?: () => BuildLogsOpenIn;
};

type Session = {
    key: string;
    header: BuildLogsHeader;
    generation: number;
    lines: string[];
    truncatedCount: number;
    unbounded: boolean;
    phase: BuildLogsPhase;
    footer?: string;
    buildStatus?: string;
    expiresAtMs?: number;
    cancel?: () => void;
    ttlTimer?: NodeJS.Timeout;
    panel?: vscode.WebviewPanel;
    panelDisposables: vscode.Disposable[];
    webviewReady: boolean;
    /** Set once this panel has been moved into its own window, so the webview hides "Pop out". */
    poppedOut: boolean;
    pendingLines: string[];
    flushTimer?: NodeJS.Timeout;
};

type WebviewCommand = "fullLog" | "reload" | "copy" | "popOut";

export function getMaxViewerLines(): number {
    const configured = Number(
        vscode.workspace.getConfiguration("codebuild").get<number>("logsViewer.maxLines", DEFAULT_MAX_VIEWER_LINES)
    );

    if (!Number.isFinite(configured)) {
        return DEFAULT_MAX_VIEWER_LINES;
    }

    return Math.max(MIN_MAX_VIEWER_LINES, Math.floor(configured));
}

export function getLogsTtlMs(): number {
    const configured = Number(
        vscode.workspace.getConfiguration("codebuild").get<number>("logsViewer.ttlMinutes", DEFAULT_TTL_MINUTES)
    );
    const minutes = Number.isFinite(configured)
        ? Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, configured))
        : DEFAULT_TTL_MINUTES;

    return Math.round(minutes * 60_000);
}

export function getLogsOpenIn(): BuildLogsOpenIn {
    // Tabs by default; a floating window only when the user opts in or clicks "Pop out".
    const configured = vscode.workspace.getConfiguration("codebuild").get<string>("logsViewer.openIn", "editor");
    return configured === "window" ? "window" : "editor";
}

export function buildLogsSessionKey(profile: string, region: string, buildId: string, mode: BuildLogsMode): string {
    // JSON tuple encoding avoids delimiter-collision issues in profile/region/build values.
    return JSON.stringify([profile, region, buildId, mode]);
}

function formatPanelTitle(header: BuildLogsHeader): string {
    // Build IDs are "<project>:<uuid>"; the first UUID segment is enough to tell tabs apart.
    const uuid = header.buildId.includes(":") ? header.buildId.slice(header.buildId.lastIndexOf(":") + 1) : header.buildId;
    const shortId = uuid.split("-")[0] || uuid;
    return `${header.mode === "full" ? "Full log" : "Logs"}: ${header.projectName} · ${shortId}`;
}

function isWebviewMessage(value: unknown): value is { type: "ready" } | { type: "command"; command: WebviewCommand } {
    if (!value || typeof value !== "object") {
        return false;
    }

    const message = value as { type?: unknown; command?: unknown };
    if (message.type === "ready") {
        return true;
    }

    return message.type === "command"
        && (message.command === "fullLog" || message.command === "reload" || message.command === "copy" || message.command === "popOut");
}

/**
 * Owns every build log panel: one webview per build and mode ("tail" streaming or "full"
 * snapshot), its line buffer, and the retention TTL that drops a finished session's lines.
 *
 * Re-opening a build whose session is still streaming, or finished within the TTL, just reveals
 * the existing panel instead of re-fetching. Anything else (stopped, failed, expired) starts over.
 */
export class BuildLogsPanelManager implements vscode.Disposable {
    private readonly sessions = new Map<string, Session>();
    private disposed = false;

    constructor(private readonly options: BuildLogsPanelManagerOptions = {}) {}

    public async open(
        header: BuildLogsHeader,
        openOptions?: { unbounded?: boolean }
    ): Promise<BuildLogsOpenResult> {
        const key = buildLogsSessionKey(header.profile, header.region, header.buildId, header.mode);
        const existing = this.sessions.get(key);

        if (existing && (existing.phase === "streaming" || existing.phase === "complete")) {
            await this.showPanel(existing);
            return { handle: this.createHandle(existing), reused: true };
        }

        const session: Session = existing ?? {
            key,
            header,
            generation: 0,
            lines: [],
            truncatedCount: 0,
            unbounded: false,
            phase: "streaming",
            panelDisposables: [],
            webviewReady: false,
            poppedOut: false,
            pendingLines: []
        };

        this.resetSession(session, header, openOptions?.unbounded === true);
        this.sessions.set(key, session);

        // A panel kept from an expired/stopped session already has a live webview; repaint it
        // from the fresh (empty) state instead of waiting for a "ready" that won't come again.
        if (session.panel && session.webviewReady) {
            this.postInit(session);
        }

        await this.showPanel(session);
        return { handle: this.createHandle(session), reused: false };
    }

    /** Header of the log panel that currently has focus, if any. */
    public getActiveHeader(): BuildLogsHeader | undefined {
        for (const session of this.sessions.values()) {
            if (session.panel?.active) {
                return { ...session.header };
            }
        }

        return undefined;
    }

    public getSnapshot(key: string): BuildLogsSnapshot | undefined {
        const session = this.sessions.get(key);
        if (!session) {
            return undefined;
        }

        return {
            header: { ...session.header },
            lines: [...session.lines],
            truncatedCount: session.truncatedCount,
            phase: session.phase,
            footer: session.footer,
            buildStatus: session.buildStatus,
            expiresAtMs: session.expiresAtMs,
            hasPanel: session.panel !== undefined,
            poppedOut: session.poppedOut
        };
    }

    /** Closes the panel for `key` (if open), exactly as if the user had closed its tab. */
    public closePanel(key: string): void {
        this.sessions.get(key)?.panel?.dispose();
    }

    public dispose(): void {
        this.disposed = true;

        for (const session of this.sessions.values()) {
            session.cancel?.();
            session.cancel = undefined;
            this.clearTimers(session);
            for (const disposable of session.panelDisposables) {
                disposable.dispose();
            }
            session.panelDisposables = [];
            session.panel?.dispose();
            session.panel = undefined;
        }

        this.sessions.clear();
    }

    private createHandle(session: Session): BuildLogsSessionHandle {
        const generation = session.generation;
        const isCurrent = (): boolean => (
            !this.disposed
            && this.sessions.get(session.key) === session
            && session.generation === generation
        );

        return {
            key: session.key,
            isCurrent,
            registerCanceller: (cancel) => {
                if (isCurrent()) {
                    session.cancel = cancel;
                }
            },
            appendLines: (lines) => {
                if (isCurrent() && session.phase === "streaming") {
                    this.appendLines(session, lines);
                }
            },
            finish: (phase, footer, buildStatus) => {
                if (isCurrent() && session.phase === "streaming") {
                    this.finish(session, phase, footer, buildStatus);
                }
            }
        };
    }

    private resetSession(session: Session, header: BuildLogsHeader, unbounded: boolean): void {
        session.cancel?.();
        session.cancel = undefined;
        this.clearTimers(session);

        session.header = header;
        session.generation += 1;
        session.lines = [];
        session.truncatedCount = 0;
        session.unbounded = unbounded;
        session.phase = "streaming";
        session.footer = undefined;
        session.buildStatus = undefined;
        session.expiresAtMs = undefined;
        session.pendingLines = [];
    }

    private appendLines(session: Session, newLines: string[]): void {
        if (newLines.length === 0) {
            return;
        }

        session.lines.push(...newLines);

        const maxLines = session.unbounded ? 0 : this.getMaxLines();
        if (maxLines > 0 && session.lines.length > maxLines) {
            const overflow = session.lines.length - maxLines;
            session.lines.splice(0, overflow);
            session.truncatedCount += overflow;
        }

        // Without a ready webview there is nothing to stream to; the "ready" handshake replays
        // the whole buffer, so queueing here would only duplicate lines.
        if (!session.panel || !session.webviewReady) {
            return;
        }

        session.pendingLines.push(...newLines);
        if (maxLines > 0 && session.pendingLines.length > maxLines) {
            session.pendingLines.splice(0, session.pendingLines.length - maxLines);
        }

        if (!session.flushTimer) {
            session.flushTimer = setTimeout(() => {
                session.flushTimer = undefined;
                this.flush(session);
            }, FLUSH_INTERVAL_MS);
        }
    }

    private flush(session: Session): void {
        if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = undefined;
        }

        if (session.pendingLines.length === 0 || !session.panel || !session.webviewReady) {
            session.pendingLines = [];
            return;
        }

        const lines = session.pendingLines;
        session.pendingLines = [];
        void session.panel.webview.postMessage({
            type: "append",
            lines,
            maxLines: session.unbounded ? 0 : this.getMaxLines(),
            truncatedCount: session.truncatedCount
        });
    }

    private finish(
        session: Session,
        phase: Exclude<BuildLogsPhase, "streaming" | "expired">,
        footer: string | undefined,
        buildStatus: string | undefined
    ): void {
        this.flush(session);

        session.phase = phase;
        session.footer = footer;
        session.buildStatus = buildStatus;
        session.cancel = undefined;
        this.startTtl(session);
        this.postState(session);
    }

    private startTtl(session: Session): void {
        if (session.ttlTimer) {
            clearTimeout(session.ttlTimer);
        }

        const ttlMs = this.getTtlMs();
        session.expiresAtMs = Date.now() + ttlMs;
        session.ttlTimer = setTimeout(() => {
            session.ttlTimer = undefined;
            this.expire(session);
        }, ttlMs);
        // Never keep the extension host alive just to expire a log buffer.
        session.ttlTimer.unref?.();
    }

    private expire(session: Session): void {
        if (this.sessions.get(session.key) !== session) {
            return;
        }

        if (!session.panel) {
            this.sessions.delete(session.key);
            return;
        }

        const minutes = Math.round(this.getTtlMs() / 60_000);
        session.cancel?.();
        session.cancel = undefined;
        session.generation += 1;
        session.lines = [];
        session.truncatedCount = 0;
        session.pendingLines = [];
        session.phase = "expired";
        session.footer = `These logs were cleared after the ${minutes}-minute retention window. Reload to fetch them again.`;
        session.expiresAtMs = undefined;
        logInfo(`[LOGS] Log session expired for build ${sanitizeLogValue(session.header.buildId, "buildId")}`);

        if (session.webviewReady) {
            this.postInit(session);
        }
    }

    private async showPanel(session: Session): Promise<void> {
        if (session.panel) {
            session.panel.reveal(undefined, false);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            BUILD_LOGS_PANEL_VIEW_TYPE,
            formatPanelTitle(session.header),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                enableFindWidget: true,
                // Moving the panel to its own window, or switching tabs, would otherwise reload
                // the webview and lose its scroll position and filter.
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        session.panel = panel;
        session.webviewReady = false;
        session.poppedOut = false;
        panel.webview.html = renderBuildLogsPanelHtml(panel.webview.cspSource, randomBytes(16).toString("base64"));
        session.panelDisposables = [
            panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(session, panel, message)),
            panel.onDidDispose(() => this.handlePanelDisposed(session, panel))
        ];

        if (this.getOpenIn() === "window") {
            await this.moveToNewWindow(session);
        }
    }

    private async moveToNewWindow(session: Session): Promise<void> {
        const panel = session.panel;
        // Already in its own window: moving it again would just spawn yet another window.
        if (!panel || session.poppedOut) {
            return;
        }

        try {
            // Acts on the active editor, which a just-created or just-revealed panel is.
            panel.reveal(undefined, false);
            await vscode.commands.executeCommand(MOVE_EDITOR_TO_NEW_WINDOW_COMMAND);
            session.poppedOut = true;
            this.postState(session);
        } catch (error) {
            // Older hosts and some remote/web environments don't support auxiliary windows;
            // the panel still works as a regular editor tab.
            logInfo(`[LOGS] Could not move log panel to a new window: ${sanitizeLogValue(String(error))}`);
        }
    }

    private handlePanelDisposed(session: Session, panel: vscode.WebviewPanel): void {
        if (session.panel !== panel) {
            return;
        }

        for (const disposable of session.panelDisposables) {
            disposable.dispose();
        }
        session.panelDisposables = [];
        session.panel = undefined;
        session.webviewReady = false;
        session.pendingLines = [];
        if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = undefined;
        }

        if (this.disposed || this.sessions.get(session.key) !== session) {
            return;
        }

        // A finished session stays cached (without a panel) until its TTL, so reopening it is
        // instant. Anything still streaming is stopped: nobody is watching it any more.
        if (session.phase === "complete") {
            return;
        }

        session.cancel?.();
        session.cancel = undefined;
        session.generation += 1;
        this.clearTimers(session);
        this.sessions.delete(session.key);
    }

    private handleMessage(session: Session, panel: vscode.WebviewPanel, message: unknown): void {
        if (session.panel !== panel || !isWebviewMessage(message)) {
            return;
        }

        if (message.type === "ready") {
            session.webviewReady = true;
            session.pendingLines = [];
            this.postInit(session);
            return;
        }

        void this.runWebviewCommand(session, message.command).catch((error: unknown) => {
            logError(`[LOGS] Log panel action "${message.command}" failed: ${sanitizeLogValue(String(error))}`);
        });
    }

    private async runWebviewCommand(session: Session, command: WebviewCommand): Promise<void> {
        const buildArg = {
            id: session.header.buildId,
            projectName: session.header.projectName,
            profile: session.header.profile,
            region: session.header.region
        };

        switch (command) {
            case "fullLog":
                await vscode.commands.executeCommand("codebuild.viewFullLogs", buildArg);
                return;
            case "reload":
                // Mark the session as not reusable so the command below starts it over in place.
                session.cancel?.();
                session.cancel = undefined;
                session.generation += 1;
                session.phase = "stopped";
                await vscode.commands.executeCommand(
                    session.header.mode === "full" ? "codebuild.viewFullLogs" : "codebuild.viewLogs",
                    buildArg
                );
                return;
            case "copy":
                await vscode.env.clipboard.writeText(session.lines.join("\n"));
                vscode.window.setStatusBarMessage(`BuildCompanion: copied ${session.lines.length} log line(s)`, 3000);
                return;
            case "popOut":
                await this.moveToNewWindow(session);
                return;
        }
    }

    private postInit(session: Session): void {
        if (!session.panel) {
            return;
        }

        void session.panel.webview.postMessage({
            type: "init",
            header: session.header,
            lines: session.lines,
            maxLines: session.unbounded ? 0 : this.getMaxLines(),
            truncatedCount: session.truncatedCount,
            ...this.describeState(session)
        });
    }

    private postState(session: Session): void {
        if (!session.panel || !session.webviewReady) {
            return;
        }

        void session.panel.webview.postMessage({ type: "state", ...this.describeState(session) });
    }

    private describeState(session: Session): Record<string, unknown> {
        return {
            phase: session.phase,
            footer: session.footer ?? null,
            buildStatus: session.buildStatus ?? null,
            ttlMinutes: Math.round(this.getTtlMs() / 60_000),
            poppedOut: session.poppedOut,
            // Relative, so a remote extension host's clock skew can't distort the countdown.
            expiresInMs: session.expiresAtMs !== undefined ? Math.max(0, session.expiresAtMs - Date.now()) : null
        };
    }

    private clearTimers(session: Session): void {
        if (session.ttlTimer) {
            clearTimeout(session.ttlTimer);
            session.ttlTimer = undefined;
        }
        if (session.flushTimer) {
            clearTimeout(session.flushTimer);
            session.flushTimer = undefined;
        }
    }

    private getTtlMs(): number {
        return this.options.getTtlMs?.() ?? getLogsTtlMs();
    }

    private getMaxLines(): number {
        return this.options.getMaxLines?.() ?? getMaxViewerLines();
    }

    private getOpenIn(): BuildLogsOpenIn {
        return this.options.getOpenIn?.() ?? getLogsOpenIn();
    }
}

let sharedManager: BuildLogsPanelManager | undefined;

export function getBuildLogsPanelManager(): BuildLogsPanelManager {
    if (!sharedManager) {
        sharedManager = new BuildLogsPanelManager();
    }

    return sharedManager;
}

export function registerBuildLogsPanels(context: vscode.ExtensionContext): void {
    const manager = getBuildLogsPanelManager();
    context.subscriptions.push({
        dispose: () => {
            manager.dispose();
            if (sharedManager === manager) {
                sharedManager = undefined;
            }
        }
    });
}
