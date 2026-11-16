import * as assert from "node:assert/strict";
import { createAppStore } from "../../state/store";
import { clearProjectSelection } from "../../commands/batchDeploy";

describe("commands/batchDeploy", () => {
    describe("clearProjectSelection", () => {
        it("unchecks every selected project in the current scope, including ones hidden by the filter", () => {
            const store = createAppStore({
                currentProfile: "dev",
                currentRegion: "us-east-1",
                projects: [{ name: "api" }, { name: "web" }, { name: "worker" }]
            });
            try {
                store.setProjectSelected("api", "dev", "us-east-1", true);
                store.setProjectSelected("worker", "dev", "us-east-1", true);
                store.setProjectFilter("api");

                clearProjectSelection(store);

                assert.deepEqual(store.getSelectedProjects("dev", "us-east-1"), []);
            } finally {
                store.dispose();
            }
        });

        it("leaves selections in other profiles and regions alone", () => {
            const store = createAppStore({ currentProfile: "dev", currentRegion: "us-east-1" });
            try {
                store.setProjectSelected("api", "dev", "us-east-1", true);
                store.setProjectSelected("api", "dev", "eu-west-1", true);
                store.setProjectSelected("api", "prod", "us-east-1", true);

                clearProjectSelection(store);

                assert.deepEqual(store.getSelectedProjects("dev", "us-east-1"), []);
                assert.deepEqual(store.getSelectedProjects("dev", "eu-west-1"), ["api"]);
                assert.deepEqual(store.getSelectedProjects("prod", "us-east-1"), ["api"]);
            } finally {
                store.dispose();
            }
        });

        it("does nothing (and does not refresh the tree) when nothing is selected", () => {
            const store = createAppStore({ currentProfile: "dev", currentRegion: "us-east-1" });
            try {
                let refreshes = 0;
                store.onDidRefresh(() => { refreshes += 1; });

                clearProjectSelection(store);

                assert.equal(refreshes, 0);
            } finally {
                store.dispose();
            }
        });

        it("does nothing without a selected profile", () => {
            const store = createAppStore({ currentProfile: null });
            try {
                assert.doesNotThrow(() => clearProjectSelection(store));
            } finally {
                store.dispose();
            }
        });
    });
});
