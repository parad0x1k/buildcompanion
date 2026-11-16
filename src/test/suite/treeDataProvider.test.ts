import * as assert from "node:assert/strict";
import { createAppStore } from "../../state/store";
import { CodeBuildTreeDataProvider, type TreeNode } from "../../ui/treeDataProvider";

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ui/treeDataProvider", () => {
    describe("CodeBuildTreeDataProvider refresh scope", () => {
        it("fires a scoped refresh for the specific project history group once its history load settles", async () => {
            const store = createAppStore({
                currentProfile: "dev",
                projects: [{ name: "demo" }]
            });

            let releaseLoad: () => void = () => undefined;
            const loadGate = new Promise<void>((resolve) => {
                releaseLoad = resolve;
            });
            const loadBuildHistoryForProject = async () => {
                await loadGate;
            };

            const provider = new CodeBuildTreeDataProvider(store, loadBuildHistoryForProject);
            try {
                const fired: Array<TreeNode | undefined> = [];
                provider.onDidChangeTreeData((element) => fired.push(element as TreeNode | undefined));

                const historyGroupNode: TreeNode = { kind: "projectHistoryGroup", project: { name: "demo" } };
                const children = provider.getChildren(historyGroupNode);

                assert.equal(children.length, 1);
                assert.equal(children[0].kind, "message");

                releaseLoad();
                await wait(20);

                assert.equal(fired.length, 1, "expected exactly one refresh after the history load settled");
                assert.deepEqual(
                    fired[0],
                    historyGroupNode,
                    "refresh should be scoped to the project history group node, not a whole-tree refresh"
                );
            } finally {
                provider.dispose();
            }
        });

        it("still fires a whole-tree refresh for unrelated store changes", () => {
            const store = createAppStore({ currentProfile: "dev" });
            const provider = new CodeBuildTreeDataProvider(store, async () => undefined);
            try {
                const fired: Array<TreeNode | undefined> = [];
                provider.onDidChangeTreeData((element) => fired.push(element as TreeNode | undefined));

                store.setCurrentRegion("eu-west-1");

                assert.equal(fired.length, 1);
                assert.equal(fired[0], undefined, "a generic store refresh should still refresh the whole tree");
            } finally {
                provider.dispose();
            }
        });
    });

    describe("build duration display", () => {
        it("shows how long a history build took in its description and tooltip", () => {
            const store = createAppStore({ currentProfile: "dev", buildTimeDisplayFormat: "utc" });
            const provider = new CodeBuildTreeDataProvider(store, async () => undefined);
            try {
                const item = provider.getTreeItem({
                    kind: "historyBuild",
                    build: {
                        id: "demo:1",
                        projectName: "demo",
                        status: "SUCCEEDED",
                        profile: "dev",
                        region: "us-east-1",
                        initiator: "alice",
                        sourceVersion: "main",
                        startedAt: "2026-01-01T00:00:00.000Z",
                        endedAt: "2026-01-01T00:04:12.000Z",
                        durationSeconds: 252
                    }
                });

                assert.match(String(item.description), /^Completed: .+ • took 4m 12s$/);
                assert.match(String(item.tooltip), /Duration: 4m 12s/);
            } finally {
                provider.dispose();
            }
        });

        it("marks the duration unavailable for a history build without an end time", () => {
            const store = createAppStore({ currentProfile: "dev" });
            const provider = new CodeBuildTreeDataProvider(store, async () => undefined);
            try {
                const item = provider.getTreeItem({
                    kind: "historyBuild",
                    build: {
                        id: "demo:2",
                        projectName: "demo",
                        status: "IN_PROGRESS",
                        profile: "dev",
                        region: "us-east-1",
                        initiator: "alice",
                        sourceVersion: "main",
                        startedAt: "2026-01-01T00:00:00.000Z"
                    }
                });

                assert.equal(item.description, undefined);
                assert.match(String(item.tooltip), /Duration: unavailable/);
            } finally {
                provider.dispose();
            }
        });

        it("shows how long a failed build ran before failing", () => {
            const store = createAppStore({ currentProfile: "dev", buildTimeDisplayFormat: "utc" });
            const provider = new CodeBuildTreeDataProvider(store, async () => undefined);
            try {
                const item = provider.getTreeItem({
                    kind: "failedBuild",
                    build: {
                        id: "demo:3",
                        projectName: "demo",
                        status: "FAILED",
                        profile: "dev",
                        region: "us-east-1",
                        failedAt: "2026-01-01T00:03:05.000Z",
                        durationSeconds: 185
                    }
                });

                assert.match(String(item.description), /after 3m 5s$/);
                assert.match(String(item.tooltip), /Ran for: 3m 5s/);
            } finally {
                provider.dispose();
            }
        });
    });
});
