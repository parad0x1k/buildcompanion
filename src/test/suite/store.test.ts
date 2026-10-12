import * as assert from "node:assert/strict";
import { createAppStore, type BuildHistoryEntry, type BuildState } from "../../state/store";

function makeBuild(overrides: Partial<BuildState> = {}): BuildState {
    return {
        id: "build-1",
        projectName: "demo",
        status: "IN_PROGRESS",
        profile: "dev",
        region: "us-east-1",
        ...overrides
    };
}

function makeHistoryEntry(overrides: Partial<BuildHistoryEntry> = {}): BuildHistoryEntry {
    return {
        id: "build-1",
        projectName: "demo",
        status: "SUCCEEDED",
        profile: "dev",
        region: "us-east-1",
        initiator: "alice",
        sourceVersion: "main",
        ...overrides
    };
}

describe("state/store", () => {
    it("starts with sane defaults", () => {
        const store = createAppStore();
        const state = store.getState();

        assert.equal(state.currentProfile, null);
        assert.equal(state.currentRegion, "us-east-1");
        assert.equal(state.autoRefreshEnabled, true);
        assert.deepEqual(state.projects, []);
        assert.deepEqual(state.activeBuilds, []);
    });

    it("does not fire onDidRefresh when setting an unchanged value", () => {
        const store = createAppStore();
        let refreshCount = 0;
        store.onDidRefresh(() => { refreshCount += 1; });

        store.setCurrentRegion("us-east-1"); // same as default
        assert.equal(refreshCount, 0);

        store.setCurrentRegion("eu-west-1");
        assert.equal(refreshCount, 1);
    });

    it("coalesces multiple mutations inside batchUpdate into a single refresh", () => {
        const store = createAppStore();
        let refreshCount = 0;
        store.onDidRefresh(() => { refreshCount += 1; });

        store.batchUpdate(() => {
            store.setCurrentProfile("dev");
            store.setCurrentRegion("eu-west-1");
            store.setProjects([{ name: "demo" }]);
        });

        assert.equal(refreshCount, 1);
    });

    it("getState returns a frozen snapshot that is unaffected by later mutations", () => {
        const store = createAppStore();
        store.setProjects([{ name: "demo" }]);

        const snapshot = store.getState();
        assert.ok(Object.isFrozen(snapshot));
        assert.throws(() => {
            (snapshot as { currentRegion: string }).currentRegion = "mutated";
        }, TypeError);

        store.setProjects([{ name: "demo" }, { name: "second" }]);

        // The previously captured snapshot must remain exactly as it was taken.
        assert.equal(snapshot.projects.length, 1);
        assert.equal(store.getState().projects.length, 2);
    });

    describe("project selection", () => {
        it("scopes selection by project + profile + region", () => {
            const store = createAppStore();
            store.setProjectSelected("demo", "dev", "us-east-1", true);

            assert.equal(store.isProjectSelected("demo", "dev", "us-east-1"), true);
            assert.equal(store.isProjectSelected("demo", "prod", "us-east-1"), false);
            assert.deepEqual(store.getSelectedProjects("dev", "us-east-1"), ["demo"]);
        });

        it("clearAllProjectSelections removes every scope", () => {
            const store = createAppStore();
            store.setProjectSelected("demo", "dev", "us-east-1", true);
            store.setProjectSelected("other", "prod", "eu-west-1", true);

            store.clearAllProjectSelections();

            assert.deepEqual(store.getSelectedProjects("dev", "us-east-1"), []);
            assert.deepEqual(store.getSelectedProjects("prod", "eu-west-1"), []);
        });
    });

    describe("project branches", () => {
        it("stores and retrieves a scoped branch", () => {
            const store = createAppStore();
            store.setProjectBranchForScope("demo", "feature/x", "dev", "us-east-1");

            assert.equal(store.getProjectBranchForScope("demo", "dev", "us-east-1"), "feature/x");
            assert.equal(store.getProjectBranchForScope("demo", "prod", "us-east-1"), undefined);
        });

        it("falls back to the legacy unscoped key", () => {
            const store = createAppStore();
            store.setProjectBranch("demo", "main"); // legacy unscoped setter

            assert.equal(store.getProjectBranchForScope("demo", "dev", "us-east-1"), "main");
        });

        it("clearing a scoped branch with an empty value removes it", () => {
            const store = createAppStore();
            store.setProjectBranchForScope("demo", "feature/x", "dev", "us-east-1");
            store.setProjectBranchForScope("demo", "", "dev", "us-east-1");

            assert.equal(store.getProjectBranchForScope("demo", "dev", "us-east-1"), undefined);
        });

        it("clearAllProjectBranches empties every mapping", () => {
            const store = createAppStore();
            store.setProjectBranchForScope("demo", "main", "dev", "us-east-1");
            store.clearAllProjectBranches();

            assert.equal(store.getProjectBranchForScope("demo", "dev", "us-east-1"), undefined);
        });
    });

    describe("pending builds", () => {
        it("upserts and retrieves a pending build by project/profile/region", () => {
            const store = createAppStore();
            store.upsertPendingBuild({
                projectName: "demo",
                profile: "dev",
                region: "us-east-1",
                cancellationFenceToken: 0
            });

            assert.equal(store.hasPendingBuild("demo", "dev", "us-east-1"), true);
            assert.equal(store.hasPendingBuild("demo", "prod", "us-east-1"), false);
        });

        it("removePendingBuildsForScope only removes matching scope entries", () => {
            const store = createAppStore();
            store.upsertPendingBuild({ projectName: "a", profile: "dev", region: "us-east-1", cancellationFenceToken: 0 });
            store.upsertPendingBuild({ projectName: "b", profile: "prod", region: "us-east-1", cancellationFenceToken: 0 });

            store.removePendingBuildsForScope("dev", "us-east-1");

            assert.equal(store.hasPendingBuild("a", "dev", "us-east-1"), false);
            assert.equal(store.hasPendingBuild("b", "prod", "us-east-1"), true);
        });
    });

    describe("destructive action blocks", () => {
        it("blocks and clears per scope", () => {
            const store = createAppStore();
            store.blockDestructiveActionsForScope("dev", "us-east-1", "refresh failed");

            assert.equal(store.isDestructiveActionBlockedForScope("dev", "us-east-1"), true);
            assert.equal(store.getDestructiveActionBlockForScope("dev", "us-east-1"), "refresh failed");

            store.clearDestructiveActionBlockForScope("dev", "us-east-1");
            assert.equal(store.isDestructiveActionBlockedForScope("dev", "us-east-1"), false);
        });
    });

    describe("cancellation fence", () => {
        it("starts at 0 and increments on bump", () => {
            const store = createAppStore();
            assert.equal(store.getScopeCancellationFence("dev", "us-east-1"), 0);

            const next = store.bumpScopeCancellationFence("dev", "us-east-1");
            assert.equal(next, 1);
            assert.equal(store.getScopeCancellationFence("dev", "us-east-1"), 1);
        });
    });

    describe("build history", () => {
        it("stores entries per profile/region/project and tracks the loaded flag", () => {
            const store = createAppStore();
            assert.equal(store.isProjectBuildHistoryLoaded("dev", "us-east-1", "demo"), false);

            store.setProjectBuildHistory("dev", "us-east-1", "demo", [makeHistoryEntry()]);

            assert.equal(store.isProjectBuildHistoryLoaded("dev", "us-east-1", "demo"), true);
            assert.equal(store.getProjectBuildHistory("dev", "us-east-1", "demo").length, 1);
        });

        it("clamps history entries to maxEntries", () => {
            const store = createAppStore();
            const entries = Array.from({ length: 5 }, (_, index) => makeHistoryEntry({ id: `build-${index}` }));

            store.setProjectBuildHistory("dev", "us-east-1", "demo", entries, 2);

            assert.equal(store.getProjectBuildHistory("dev", "us-east-1", "demo").length, 2);
        });

        it("clearBuildHistoryCache resets entries and loaded flags", () => {
            const store = createAppStore();
            store.setProjectBuildHistory("dev", "us-east-1", "demo", [makeHistoryEntry()]);

            store.clearBuildHistoryCache();

            assert.equal(store.isProjectBuildHistoryLoaded("dev", "us-east-1", "demo"), false);
            assert.deepEqual(store.getProjectBuildHistory("dev", "us-east-1", "demo"), []);
        });
    });

    describe("active builds", () => {
        it("round-trips active build state", () => {
            const store = createAppStore();
            store.setActiveBuilds([makeBuild()]);

            assert.equal(store.getState().activeBuilds.length, 1);
            assert.equal(store.getState().activeBuilds[0].id, "build-1");
        });
    });
});
