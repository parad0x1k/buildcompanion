import * as assert from "node:assert/strict";
import {
    BuildLogsPanelManager,
    buildLogsSessionKey,
    getLogsOpenIn,
    type BuildLogsHeader,
    type BuildLogsPanelManagerOptions
} from "../../ui/buildLogsPanel";

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function header(overrides: Partial<BuildLogsHeader> = {}): BuildLogsHeader {
    return {
        projectName: "demo",
        profile: "dev",
        region: "us-east-1",
        buildId: "demo:11111111-2222-3333-4444-555555555555",
        mode: "tail",
        ...overrides
    };
}

function keyOf(value: BuildLogsHeader): string {
    return buildLogsSessionKey(value.profile, value.region, value.buildId, value.mode);
}

describe("ui/buildLogsPanel", () => {
    let manager: BuildLogsPanelManager;

    function createManager(options: BuildLogsPanelManagerOptions = {}): BuildLogsPanelManager {
        // "editor" keeps the test run from opening auxiliary windows.
        manager = new BuildLogsPanelManager({ getOpenIn: () => "editor", ...options });
        return manager;
    }

    afterEach(() => {
        manager?.dispose();
    });

    describe("getLogsOpenIn", () => {
        it("opens log panels as tabs by default, never popped out unless asked", () => {
            assert.equal(getLogsOpenIn(), "editor");
        });
    });

    describe("buildLogsSessionKey", () => {
        it("separates live and full-log sessions of the same build", () => {
            assert.notEqual(
                buildLogsSessionKey("dev", "us-east-1", "demo:1", "tail"),
                buildLogsSessionKey("dev", "us-east-1", "demo:1", "full")
            );
        });

        it("does not collide when values contain the separator characters", () => {
            assert.notEqual(
                buildLogsSessionKey("a,b", "c", "d", "tail"),
                buildLogsSessionKey("a", "b,c", "d", "tail")
            );
        });
    });

    describe("BuildLogsPanelManager", () => {
        it("opens a streaming session with a panel and an empty buffer", async () => {
            createManager();
            const { reused } = await manager.open(header());

            const snapshot = manager.getSnapshot(keyOf(header()));
            assert.equal(reused, false);
            assert.ok(snapshot);
            assert.equal(snapshot.phase, "streaming");
            assert.equal(snapshot.hasPanel, true);
            // Opened as a tab ("editor" mode), so Pop out must still be offered.
            assert.equal(snapshot.poppedOut, false);
            assert.deepEqual(snapshot.lines, []);
        });

        it("drops the oldest lines past the cap and counts them", async () => {
            createManager({ getMaxLines: () => 5 });
            const { handle } = await manager.open(header());

            handle.appendLines(["l0", "l1", "l2", "l3"]);
            handle.appendLines(["l4", "l5", "l6"]);

            const snapshot = manager.getSnapshot(handle.key);
            assert.deepEqual(snapshot?.lines, ["l2", "l3", "l4", "l5", "l6"]);
            assert.equal(snapshot?.truncatedCount, 2);
        });

        it("never truncates an unbounded (full log) session", async () => {
            createManager({ getMaxLines: () => 5 });
            const { handle } = await manager.open(header({ mode: "full" }), { unbounded: true });

            handle.appendLines(Array.from({ length: 12 }, (_, index) => `line-${index}`));

            const snapshot = manager.getSnapshot(handle.key);
            assert.equal(snapshot?.lines.length, 12);
            assert.equal(snapshot?.truncatedCount, 0);
        });

        it("reuses a session that is still streaming instead of restarting it", async () => {
            createManager();
            const first = await manager.open(header());
            first.handle.appendLines(["kept"]);

            const second = await manager.open(header());

            assert.equal(second.reused, true);
            assert.equal(first.handle.isCurrent(), true);
            assert.deepEqual(manager.getSnapshot(first.handle.key)?.lines, ["kept"]);
        });

        it("records the final phase, footer and build status, and starts the retention TTL", async () => {
            createManager({ getTtlMs: () => 60_000 });
            const { handle } = await manager.open(header());
            handle.appendLines(["done"]);

            const before = Date.now();
            handle.finish("complete", "End of log stream", "SUCCEEDED");

            const snapshot = manager.getSnapshot(handle.key);
            assert.equal(snapshot?.phase, "complete");
            assert.equal(snapshot?.footer, "End of log stream");
            assert.equal(snapshot?.buildStatus, "SUCCEEDED");
            assert.ok(snapshot?.expiresAtMs !== undefined && snapshot.expiresAtMs >= before + 60_000);
        });

        it("ignores appends and a second finish once a session has finished", async () => {
            createManager();
            const { handle } = await manager.open(header());
            handle.finish("complete", "first", "SUCCEEDED");

            handle.appendLines(["late line"]);
            handle.finish("failed", "second");

            const snapshot = manager.getSnapshot(handle.key);
            assert.deepEqual(snapshot?.lines, []);
            assert.equal(snapshot?.phase, "complete");
            assert.equal(snapshot?.footer, "first");
        });

        it("keeps a finished session cached after its panel closes and restores it on re-open", async () => {
            createManager({ getTtlMs: () => 60_000 });
            const { handle } = await manager.open(header());
            handle.appendLines(["cached line"]);
            handle.finish("complete", "End of log stream", "SUCCEEDED");

            manager.closePanel(handle.key);
            await wait(20);
            assert.equal(manager.getSnapshot(handle.key)?.hasPanel, false);

            const reopened = await manager.open(header());
            const snapshot = manager.getSnapshot(handle.key);
            assert.equal(reopened.reused, true);
            assert.equal(snapshot?.hasPanel, true);
            assert.deepEqual(snapshot?.lines, ["cached line"]);
        });

        it("stops the stream and discards the session when a streaming panel is closed", async () => {
            createManager();
            const { handle } = await manager.open(header());
            let cancelled = 0;
            handle.registerCanceller(() => { cancelled += 1; });

            manager.closePanel(handle.key);
            await wait(20);

            assert.equal(cancelled, 1);
            assert.equal(manager.getSnapshot(handle.key), undefined);
            assert.equal(handle.isCurrent(), false);
        });

        it("restarts a stopped session with a fresh buffer and isolates the old stream's handle", async () => {
            createManager();
            const first = await manager.open(header());
            first.handle.appendLines(["old"]);
            first.handle.finish("stopped", "Log streaming stopped.");

            const second = await manager.open(header());
            assert.equal(second.reused, false);
            assert.equal(first.handle.isCurrent(), false);
            assert.equal(second.handle.isCurrent(), true);

            // A late callback from the first stream must not leak into the new session.
            first.handle.appendLines(["stale"]);
            first.handle.finish("failed", "stale failure");
            second.handle.appendLines(["fresh"]);

            const snapshot = manager.getSnapshot(second.handle.key);
            assert.equal(snapshot?.phase, "streaming");
            assert.deepEqual(snapshot?.lines, ["fresh"]);
            assert.equal(snapshot?.footer, undefined);
        });

        it("clears an open panel's lines when the TTL elapses and then allows a fresh start", async () => {
            createManager({ getTtlMs: () => 30 });
            const { handle } = await manager.open(header());
            handle.appendLines(["will expire"]);
            handle.finish("complete", "End of log stream", "SUCCEEDED");

            await wait(120);

            const expired = manager.getSnapshot(handle.key);
            assert.equal(expired?.phase, "expired");
            assert.deepEqual(expired?.lines, []);
            assert.equal(expired?.hasPanel, true);
            assert.equal(handle.isCurrent(), false);

            const restarted = await manager.open(header());
            assert.equal(restarted.reused, false);
            assert.equal(manager.getSnapshot(handle.key)?.phase, "streaming");
        });

        it("forgets a cached session entirely when the TTL elapses with no panel open", async () => {
            createManager({ getTtlMs: () => 30 });
            const { handle } = await manager.open(header());
            handle.finish("complete", "End of log stream", "SUCCEEDED");
            manager.closePanel(handle.key);

            await wait(120);

            assert.equal(manager.getSnapshot(handle.key), undefined);
        });

        it("cancels every active stream on dispose", async () => {
            createManager();
            const a = await manager.open(header());
            const b = await manager.open(header({ buildId: "demo:other" }));
            let cancelled = 0;
            a.handle.registerCanceller(() => { cancelled += 1; });
            b.handle.registerCanceller(() => { cancelled += 1; });

            manager.dispose();

            assert.equal(cancelled, 2);
            assert.equal(a.handle.isCurrent(), false);
            assert.equal(manager.getSnapshot(a.handle.key), undefined);
        });
    });
});
