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
});
