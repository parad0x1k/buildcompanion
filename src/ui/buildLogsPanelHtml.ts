/**
 * Markup, styles and script for the build log panel webview. Everything is inline (gated by a
 * per-render nonce) and log text only ever reaches the DOM through `textContent`, never HTML, so
 * nothing a build prints can execute in the panel.
 *
 * Protocol (extension → webview):
 *   init   { header, lines, maxLines, truncatedCount, phase, footer, buildStatus, waitingMessage, ttlMinutes, expiresInMs }
 *   append { lines, maxLines, truncatedCount }
 *   state  { phase, footer, buildStatus, waitingMessage, ttlMinutes, expiresInMs, poppedOut }
 * Protocol (webview → extension):
 *   ready
 *   command { command: "fullLog" | "reload" | "copy" | "popOut" }
 */
export function renderBuildLogsPanelHtml(cspSource: string, nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Build Logs</title>
<style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        height: 100vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
    }
    .top {
        flex: none;
        padding: 10px 14px 8px;
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .dot {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--vscode-descriptionForeground);
    }
    .dot.streaming { background: var(--vscode-charts-blue, #3794ff); animation: pulse 1.4s ease-in-out infinite; }
    .dot.ok { background: var(--vscode-testing-iconPassed, #73c991); }
    .dot.bad { background: var(--vscode-testing-iconFailed, #f14c4c); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    @media (prefers-reduced-motion: reduce) { .dot.streaming { animation: none; } }
    .project { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge {
        flex: none;
        font-size: 11px;
        padding: 1px 7px;
        border-radius: 10px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
    }
    .status { flex: none; margin-left: auto; font-size: 12px; white-space: nowrap; }
    .status.ok { color: var(--vscode-testing-iconPassed, inherit); }
    .status.bad { color: var(--vscode-errorForeground); }
    .status.muted { color: var(--vscode-descriptionForeground); }
    .meta {
        margin-top: 4px;
        display: flex;
        flex-wrap: wrap;
        gap: 2px 14px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
    }
    .meta .mono { font-family: var(--vscode-editor-font-family); }
    .toolbar {
        flex: none;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 6px 14px;
        border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .search { flex: 1 1 200px; min-width: 140px; display: flex; align-items: center; gap: 8px; }
    input[type="search"] {
        flex: 1;
        min-width: 0;
        padding: 3px 6px;
        font: inherit;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
    }
    input[type="search"]::placeholder { color: var(--vscode-input-placeholderForeground); }
    .count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .actions { display: flex; flex-wrap: wrap; gap: 4px; }
    button {
        font: inherit;
        font-size: 12px;
        padding: 3px 9px;
        border: none;
        border-radius: 2px;
        cursor: pointer;
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.toggle[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.toggle[aria-pressed="true"]:hover { background: var(--vscode-button-hoverBackground); }
    input:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    main {
        flex: 1;
        overflow: auto;
        padding: 6px 0 14px;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
        line-height: 1.45;
    }
    .notice { margin: 0 14px 6px; font-size: 12px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
    .l { display: flex; padding-right: 14px; white-space: pre; }
    main.wrap .l { white-space: pre-wrap; overflow-wrap: anywhere; }
    .l:hover { background: var(--vscode-list-hoverBackground); }
    .l .n {
        flex: none;
        min-width: 6ch;
        padding: 0 12px 0 8px;
        text-align: right;
        user-select: none;
        color: var(--vscode-editorLineNumber-foreground);
    }
    .l .t { flex: 1; min-width: 0; }
    .l.err .t { color: var(--vscode-errorForeground); }
    .l.warn .t { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
    .l.phase .t { font-weight: 600; color: var(--vscode-textLink-foreground); }
    .l.hidden { display: none; }
    .empty { padding: 18px 14px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
    .footer {
        margin: 10px 14px 0;
        padding: 8px 10px;
        white-space: pre-wrap;
        font-family: var(--vscode-font-family);
        border-left: 3px solid var(--vscode-descriptionForeground);
        background: var(--vscode-textBlockQuote-background);
    }
    .footer.ok { border-left-color: var(--vscode-testing-iconPassed, #73c991); }
    .footer.bad { border-left-color: var(--vscode-testing-iconFailed, #f14c4c); }
    .footer button { margin-top: 8px; }
    #jump {
        position: fixed;
        right: 18px;
        bottom: 16px;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
    }
    #jump:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
    <header class="top">
        <div class="title-row">
            <span id="dot" class="dot streaming" aria-hidden="true"></span>
            <span id="project" class="project">Build logs</span>
            <span id="mode" class="badge">Live</span>
            <span id="status" class="status muted" role="status">Connecting…</span>
        </div>
        <div class="meta">
            <span>Build <span id="buildId" class="mono"></span></span>
            <span id="scope"></span>
            <span id="retention"></span>
        </div>
    </header>
    <div class="toolbar">
        <div class="search">
            <input id="filter" type="search" placeholder="Filter lines" aria-label="Filter log lines">
            <span id="count" class="count"></span>
        </div>
        <div class="actions">
            <button id="follow" class="toggle" aria-pressed="true" title="Keep the newest line in view">Follow</button>
            <button id="wrap" class="toggle" aria-pressed="false" title="Wrap long lines">Wrap</button>
            <button id="errors" class="toggle" aria-pressed="false" title="Show only error and warning lines">Errors</button>
            <button id="fullLog" title="Open the entire log from the beginning">Full log</button>
            <button id="copy" title="Copy every retained line">Copy</button>
            <button id="popOut" title="Move this panel into its own window">Pop out</button>
            <button id="reload" title="Discard these lines and fetch again">Reload</button>
        </div>
    </div>
    <main id="body">
        <div id="notice" class="notice" hidden></div>
        <div id="lines"></div>
        <div id="empty" class="empty">Waiting for log output…</div>
        <div id="footer" class="footer" hidden><div id="footerText"></div></div>
    </main>
    <button id="jump" hidden>Jump to latest ↓</button>
<script nonce="${nonce}">
(function () {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const body = $("body");
    const linesEl = $("lines");

    const ERROR_PATTERN = /\\b(error|errors|failed|failure|fatal|exception|denied)\\b/i;
    const WARN_PATTERN = /\\bwarn(ing)?\\b/i;
    const PHASE_PATTERN = /\\[Container\\].*(Entering phase|Phase complete|Phase context)/;

    const saved = vscode.getState() || {};
    let wrap = saved.wrap === true;
    let errorsOnly = saved.errorsOnly === true;
    let follow = true;
    let query = "";
    let nextNumber = 1;
    let truncatedCount = 0;
    let header = null;
    let phase = "streaming";
    let expiresAt = null;
    let ttlMinutes = 15;
    let filterTimer = null;
    // Maintained incrementally so a busy stream with a filter applied doesn't rescan every row
    // on each append; only applyFilter() recounts from scratch.
    let shownCount = 0;

    function persist() {
        vscode.setState({ wrap, errorsOnly });
    }

    function setPressed(button, pressed) {
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
    }

    function classify(text) {
        if (PHASE_PATTERN.test(text)) { return "phase"; }
        if (ERROR_PATTERN.test(text)) { return "err"; }
        if (WARN_PATTERN.test(text)) { return "warn"; }
        return "";
    }

    function matches(row) {
        if (errorsOnly && !row.classList.contains("err") && !row.classList.contains("warn")) {
            return false;
        }
        return !query || row.dataset.lc.includes(query);
    }

    function makeRow(text) {
        const row = document.createElement("div");
        const kind = classify(text);
        row.className = kind ? "l " + kind : "l";
        row.dataset.lc = text.toLowerCase();
        const number = document.createElement("span");
        number.className = "n";
        number.textContent = String(nextNumber++);
        const content = document.createElement("span");
        content.className = "t";
        content.textContent = text;
        row.append(number, content);
        if (matches(row)) { shownCount++; } else { row.classList.add("hidden"); }
        return row;
    }

    function isAtBottom() {
        return body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    }

    function scrollToEnd() {
        body.scrollTop = body.scrollHeight;
    }

    function updateCount() {
        const total = linesEl.childElementCount;
        let text;
        if (query || errorsOnly) {
            text = shownCount + " of " + total + " lines";
        } else {
            text = total + (total === 1 ? " line" : " lines");
        }
        $("count").textContent = text;
        $("empty").hidden = total > 0;
        const notice = $("notice");
        notice.hidden = truncatedCount === 0;
        notice.textContent = truncatedCount > 0
            ? truncatedCount + " earlier line(s) dropped to keep this view responsive. Use Full log for the complete output."
            : "";
    }

    function appendLines(lines, maxLines) {
        if (!lines.length) { return; }
        const fragment = document.createDocumentFragment();
        for (const line of lines) { fragment.appendChild(makeRow(line)); }
        linesEl.appendChild(fragment);
        if (maxLines > 0) {
            let excess = linesEl.childElementCount - maxLines;
            while (excess-- > 0 && linesEl.firstElementChild) {
                const first = linesEl.firstElementChild;
                if (!first.classList.contains("hidden")) { shownCount--; }
                first.remove();
            }
        }
        updateCount();
        if (follow) { scrollToEnd(); }
    }

    function applyFilter() {
        shownCount = 0;
        for (const row of linesEl.children) {
            const visible = matches(row);
            row.classList.toggle("hidden", !visible);
            if (visible) { shownCount++; }
        }
        updateCount();
        if (follow) { scrollToEnd(); }
    }

    function statusFor(currentPhase, buildStatus) {
        switch (currentPhase) {
            case "streaming":
                return { text: header && header.mode === "full" ? "Loading…" : "Streaming…", tone: "muted", dot: "streaming" };
            case "complete":
                if (buildStatus === "SUCCEEDED") { return { text: "Succeeded", tone: "ok", dot: "ok" }; }
                if (buildStatus === "FAILED" || buildStatus === "FAULT" || buildStatus === "TIMED_OUT") {
                    return { text: buildStatus === "TIMED_OUT" ? "Timed out" : buildStatus === "FAULT" ? "Fault" : "Failed", tone: "bad", dot: "bad" };
                }
                if (buildStatus === "STOPPED") { return { text: "Stopped", tone: "muted", dot: "" }; }
                return { text: buildStatus === "IN_PROGRESS" ? "In progress (snapshot)" : (buildStatus || "Done"), tone: "muted", dot: "" };
            case "stopped":
                return { text: "Stream stopped", tone: "muted", dot: "" };
            case "failed":
                return { text: "Stream error", tone: "bad", dot: "bad" };
            case "expired":
                return { text: "Expired", tone: "muted", dot: "" };
            default:
                return { text: "", tone: "muted", dot: "" };
        }
    }

    function renderRetention() {
        const el = $("retention");
        if (phase === "expired") {
            el.textContent = "Lines cleared after " + ttlMinutes + " min";
        } else if (expiresAt === null) {
            el.textContent = "Kept for " + ttlMinutes + " min after the stream ends";
        } else {
            const minutesLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));
            el.textContent = minutesLeft <= 1 ? "Clears in under a minute" : "Clears in " + minutesLeft + " min";
        }
    }

    function applyState(message) {
        phase = message.phase;
        ttlMinutes = message.ttlMinutes || ttlMinutes;
        expiresAt = typeof message.expiresInMs === "number" ? Date.now() + message.expiresInMs : null;

        // Only offer "Pop out" while the panel is still a tab in the main window.
        $("popOut").hidden = message.poppedOut === true;

        const status = statusFor(phase, message.buildStatus);
        const statusEl = $("status");
        statusEl.textContent = status.text;
        statusEl.className = "status " + status.tone;
        $("dot").className = "dot" + (status.dot ? " " + status.dot : "");

        const footer = $("footer");
        footer.hidden = !message.footer;
        footer.className = "footer" + (status.tone === "ok" ? " ok" : status.tone === "bad" ? " bad" : "");
        $("footerText").textContent = message.footer || "";
        const existingReload = footer.querySelector("button");
        if (existingReload) { existingReload.remove(); }
        if (phase === "expired" || phase === "stopped" || phase === "failed") {
            const reload = document.createElement("button");
            reload.textContent = "Reload logs";
            reload.addEventListener("click", () => send("reload"));
            footer.appendChild(reload);
        }

        $("empty").textContent = phase === "streaming"
            ? (message.waitingMessage || "Waiting for log output…")
            : "No log output.";
        renderRetention();
        if (follow) { scrollToEnd(); }
    }

    function init(message) {
        header = message.header;
        $("project").textContent = header.projectName;
        $("mode").textContent = header.mode === "full" ? "Full log" : "Live";
        $("buildId").textContent = header.buildId;
        $("scope").textContent = header.profile + " · " + header.region;
        $("fullLog").hidden = header.mode === "full";
        document.title = header.projectName + " logs";

        linesEl.replaceChildren();
        shownCount = 0;
        truncatedCount = message.truncatedCount || 0;
        nextNumber = truncatedCount + 1;
        follow = true;
        setPressed($("follow"), true);
        $("jump").hidden = true;
        appendLines(message.lines || [], message.maxLines || 0);
        updateCount();
        applyState(message);
    }

    function send(command) {
        vscode.postMessage({ type: "command", command });
    }

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message.type !== "string") { return; }
        if (message.type === "init") { init(message); }
        else if (message.type === "append") {
            truncatedCount = message.truncatedCount || 0;
            appendLines(message.lines || [], message.maxLines || 0);
        }
        else if (message.type === "state") { applyState(message); }
    });

    body.addEventListener("scroll", () => {
        const atBottom = isAtBottom();
        if (atBottom !== follow) {
            follow = atBottom;
            setPressed($("follow"), follow);
        }
        $("jump").hidden = follow || linesEl.childElementCount === 0;
    });

    $("follow").addEventListener("click", () => {
        follow = !follow;
        setPressed($("follow"), follow);
        if (follow) { scrollToEnd(); }
        $("jump").hidden = follow;
    });
    $("jump").addEventListener("click", () => {
        follow = true;
        setPressed($("follow"), true);
        scrollToEnd();
        $("jump").hidden = true;
    });
    $("wrap").addEventListener("click", () => {
        wrap = !wrap;
        setPressed($("wrap"), wrap);
        body.classList.toggle("wrap", wrap);
        persist();
    });
    $("errors").addEventListener("click", () => {
        errorsOnly = !errorsOnly;
        setPressed($("errors"), errorsOnly);
        persist();
        applyFilter();
    });
    $("filter").addEventListener("input", (event) => {
        const value = event.target.value.trim().toLowerCase();
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => { query = value; applyFilter(); }, 120);
    });
    $("fullLog").addEventListener("click", () => send("fullLog"));
    $("copy").addEventListener("click", () => send("copy"));
    $("popOut").addEventListener("click", () => send("popOut"));
    $("reload").addEventListener("click", () => send("reload"));

    setPressed($("wrap"), wrap);
    setPressed($("errors"), errorsOnly);
    body.classList.toggle("wrap", wrap);
    setInterval(renderRetention, 15000);

    vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
