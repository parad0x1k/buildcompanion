import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import * as sinon from "sinon";
import * as profileManager from "../../aws/profileManager";
import * as codebuildService from "../../aws/codebuildService";
import { createAppStore } from "../../state/store";
import { initializeCommandState, registerCodeBuildCommands } from "../../commands";
import { createFakeExtensionContext, disposeFakeExtensionContext } from "../testHelpers";

// __dirname at runtime is out/test/suite; three levels up is the repo root's package.json.
const manifest = require(path.join(__dirname, "..", "..", "..", "package.json")) as {
    contributes: { commands: Array<{ command: string }> };
};

describe("command registration", () => {
    let listAwsProfilesStub: sinon.SinonStub;
    let listCodeBuildProjectsStub: sinon.SinonStub;
    let listRecentActiveBuildsStub: sinon.SinonStub;

    beforeEach(() => {
        // The real extension activation path reads the host machine's ~/.aws config and can
        // call real AWS APIs. Stubbing these at the module level keeps this test deterministic
        // and network-free regardless of what AWS profiles happen to exist on the test runner.
        listAwsProfilesStub = sinon.stub(profileManager, "listAwsProfiles").resolves([]);
        listCodeBuildProjectsStub = sinon.stub(codebuildService, "listCodeBuildProjects").resolves([]);
        listRecentActiveBuildsStub = sinon.stub(codebuildService, "listRecentActiveBuilds").resolves([]);
    });

    afterEach(() => {
        sinon.restore();
    });

    it("registers every command declared in package.json without throwing", async function () {
        this.timeout(20000);

        const store = createAppStore();
        const context = createFakeExtensionContext();

        // Note: command registrations (and the shared output channel they attach to
        // context.subscriptions) are intentionally left active for the rest of the test
        // process instead of disposed here, since `registerCodeBuildCommands` lazily creates
        // module-level singletons (e.g. the shared "BuildCompanion" output channel) that other
        // test files also rely on via logInfo/logError; disposing them here would leave later
        // test files writing to an already-disposed channel.
        await initializeCommandState(context, store);
        registerCodeBuildCommands({ context, store });

        const registeredCommands = await vscode.commands.getCommands(true);

        for (const { command } of manifest.contributes.commands) {
            assert.ok(
                registeredCommands.includes(command),
                `Expected command '${command}' to be registered`
            );
        }

        assert.ok(listAwsProfilesStub.called, "listAwsProfiles should be invoked during initialization");
    });

    it("starts active-build reconciliation without waiting for the project listing to finish", async () => {
        listAwsProfilesStub.resolves([{ name: "dev", region: "us-east-1" }]);

        let releaseProjects: () => void = () => undefined;
        listCodeBuildProjectsStub.callsFake(() => new Promise((resolve) => {
            releaseProjects = () => resolve([{ name: "demo" }]);
        }));
        listRecentActiveBuildsStub.resolves([
            { id: "demo:1", projectName: "demo", status: "IN_PROGRESS", profile: "dev", region: "us-east-1" }
        ]);

        const store = createAppStore({ currentRegion: "us-east-1" });
        const context = createFakeExtensionContext();

        try {
            const initialization = initializeCommandState(context, store);

            // Let profile discovery settle; the project listing is still pending at this point.
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.equal(listCodeBuildProjectsStub.callCount, 1);
            assert.equal(listRecentActiveBuildsStub.callCount, 1, "active builds should be queried in parallel with projects");

            releaseProjects();
            await initialization;

            assert.deepEqual(store.getState().projects, [{ name: "demo" }]);
            assert.equal(store.getState().activeBuilds.length, 1);
        } finally {
            disposeFakeExtensionContext(context);
            store.dispose();
        }
    });

    it("does not query project/build APIs when no AWS profiles are configured", async () => {
        const store = createAppStore();
        const context = createFakeExtensionContext();

        try {
            await initializeCommandState(context, store);

            assert.equal(store.getState().currentProfile, null);
            assert.equal(listCodeBuildProjectsStub.called, false);
            assert.equal(listRecentActiveBuildsStub.called, false);
        } finally {
            disposeFakeExtensionContext(context);
            store.dispose();
        }
    });
});
