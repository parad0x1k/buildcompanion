import * as vscode from "vscode";

/**
 * URI scheme for the per-build log viewer. Documents under this scheme are backed only by
 * `BuildLogsDocumentProvider` (no `FileSystemProvider`), so VS Code treats them as read-only
 * editor tabs: they scroll, support Find, and can be dragged to a new window like any other
 * tab, but typing into them shows "Cannot edit in read-only editor" instead of going anywhere.
 */
export const BUILD_LOGS_URI_SCHEME = "codebuild-logs";

// Keeps the viewer document responsive for long-running builds that emit very large volumes
// of log output; older lines are dropped once this cap is exceeded (see getMaxViewerLines()).
const DEFAULT_MAX_VIEWER_LINES = 10000;
const MIN_MAX_VIEWER_LINES = 500;

// Coalesces bursts of appendLines()/setFooter() calls into a single document refresh so a
// huge batch of log events (one CloudWatch page can contain thousands) triggers one re-render
// instead of one per call.
const REFRESH_THROTTLE_MS = 300;

type ViewerHeader = {
    projectName: string;
    profile: string;
    region: string;
    buildId: string;
    /** "full" renders a distinct header and (via `open`'s `unbounded` option) skips line capping. */
    mode?: "tail" | "full";
};

type ViewerState = {
    header: ViewerHeader;
    lines: string[];
    truncatedCount: number;
    footer?: string;
    cancel?: () => void;
    refreshTimer?: NodeJS.Timeout;
    /** When true, `appendLines` never truncates - used by the "full log" snapshot view. */
    unbounded?: boolean;
};

function getMaxViewerLines(): number {
    const configured = Number(
        vscode.workspace.getConfiguration("codebuild").get<number>("logsViewer.maxLines", DEFAULT_MAX_VIEWER_LINES)
    );

    if (!Number.isFinite(configured)) {
        return DEFAULT_MAX_VIEWER_LINES;
    }

    return Math.max(MIN_MAX_VIEWER_LINES, Math.floor(configured));
}

function renderHeader(header: ViewerHeader): string[] {
    const isFull = header.mode === "full";
    const lines = [
        isFull ? "BuildCompanion — Build Logs (Full Log)" : "BuildCompanion — Build Logs",
        `Project:  ${header.projectName}`,
        `Profile:  ${header.profile}`,
        `Region:   ${header.region}`,
        `Build ID: ${header.buildId}`
    ];

    if (isFull) {
        lines.push("Mode:     Full log (entire available history, from the beginning)");
    }

    lines.push("─".repeat(60));
    return lines;
}

/**
 * Supplies read-only virtual documents (scheme `codebuild-logs`) that stream a single build's
 * CloudWatch log output into its own scrollable editor tab, decoupled from the shared
 * `BuildCompanion` output channel.
 */
export class BuildLogsDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.onDidChangeEmitter.event;
    private readonly states = new Map<string, ViewerState>();

    public static buildUri(profile: string, region: string, buildId: string, variant: "tail" | "full" = "tail"): vscode.Uri {
        const safeSegment = (value: string): string => encodeURIComponent(value).replace(/%2F/gi, "_");
        const extension = variant === "full" ? ".full.log" : ".log";
        return vscode.Uri.from({
            scheme: BUILD_LOGS_URI_SCHEME,
            path: `/${safeSegment(profile)}/${safeSegment(region)}/${safeSegment(buildId)}${extension}`
        });
    }

    /**
     * Resets (or creates) the buffer for a build so each new viewing session starts clean. Pass
     * `{ unbounded: true }` for a "full log" document so `appendLines` never truncates it.
     */
    public open(uri: vscode.Uri, header: ViewerHeader, options?: { unbounded?: boolean }): void {
        const key = uri.toString();
        this.clearRefreshTimer(this.states.get(key));
        this.states.set(key, { header, lines: [], truncatedCount: 0, unbounded: options?.unbounded === true });
    }

    /** Looks up the header metadata (profile/region/buildId/...) for an open log document. */
    public getHeader(uri: vscode.Uri): ViewerHeader | undefined {
        return this.states.get(uri.toString())?.header;
    }

    public registerCanceller(uri: vscode.Uri, cancel: () => void): void {
        const state = this.states.get(uri.toString());
        if (state) {
            state.cancel = cancel;
        }
    }

    public appendLines(uri: vscode.Uri, newLines: string[]): void {
        if (newLines.length === 0) {
            return;
        }

        const key = uri.toString();
        const state = this.states.get(key);
        if (!state) {
            return;
        }

        state.lines.push(...newLines);

        if (!state.unbounded) {
            const maxLines = getMaxViewerLines();
            if (state.lines.length > maxLines) {
                const overflow = state.lines.length - maxLines;
                state.lines.splice(0, overflow);
                state.truncatedCount += overflow;
            }
        }

        this.scheduleRefresh(uri, state);
    }

    public setFooter(uri: vscode.Uri, footer: string): void {
        const state = this.states.get(uri.toString());
        if (!state) {
            return;
        }

        state.footer = footer;
        this.scheduleRefresh(uri, state);
    }

    private scheduleRefresh(uri: vscode.Uri, state: ViewerState): void {
        if (state.refreshTimer) {
            return;
        }

        state.refreshTimer = setTimeout(() => {
            state.refreshTimer = undefined;
            this.onDidChangeEmitter.fire(uri);
        }, REFRESH_THROTTLE_MS);
    }

    private clearRefreshTimer(state: ViewerState | undefined): void {
        if (state?.refreshTimer) {
            clearTimeout(state.refreshTimer);
            state.refreshTimer = undefined;
        }
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const state = this.states.get(uri.toString());
        if (!state) {
            return "This log session has ended. Close this tab and reopen logs from the tree view.";
        }

        const parts: string[] = [...renderHeader(state.header)];

        if (state.truncatedCount > 0) {
            parts.push(`… (${state.truncatedCount} earlier line(s) truncated to keep this view responsive) …`, "");
        }

        parts.push(...state.lines);

        if (state.footer) {
            parts.push("", state.footer);
        }

        return parts.join("\n");
    }

    /** Invoked when the user closes a log viewer tab; stops the underlying stream and frees its buffer. */
    public handleDocumentClosed(uri: vscode.Uri): void {
        const key = uri.toString();
        const state = this.states.get(key);
        if (!state) {
            return;
        }

        state.cancel?.();
        this.clearRefreshTimer(state);
        this.states.delete(key);
    }

    public dispose(): void {
        for (const state of this.states.values()) {
            state.cancel?.();
            this.clearRefreshTimer(state);
        }
        this.states.clear();
        this.onDidChangeEmitter.dispose();
    }
}

let sharedProvider: BuildLogsDocumentProvider | undefined;

export function getBuildLogsDocumentProvider(): BuildLogsDocumentProvider {
    if (!sharedProvider) {
        sharedProvider = new BuildLogsDocumentProvider();
    }

    return sharedProvider;
}

export function buildLogsDocumentUri(profile: string, region: string, buildId: string): vscode.Uri {
    return BuildLogsDocumentProvider.buildUri(profile, region, buildId);
}

/** URI for the unbounded "entire log history" variant of a build's log document. */
export function buildFullLogsDocumentUri(profile: string, region: string, buildId: string): vscode.Uri {
    return BuildLogsDocumentProvider.buildUri(profile, region, buildId, "full");
}

export function registerBuildLogsDocumentProvider(context: vscode.ExtensionContext): void {
    const provider = getBuildLogsDocumentProvider();
    const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(BUILD_LOGS_URI_SCHEME, provider);
    const closeSubscription = vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === BUILD_LOGS_URI_SCHEME) {
            provider.handleDocumentClosed(document.uri);
        }
    });

    context.subscriptions.push(providerRegistration, closeSubscription, provider);
}
