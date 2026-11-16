import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { BatchGetBuildsCommand, ListBuildsForProjectCommand, StartBuildCommand } from "@aws-sdk/client-codebuild";
import { TriggerBuildTool, type TriggerBuildToolInput } from "../../agent/tools/triggerBuildTool";
import { createAppStore, type AppStore } from "../../state/store";
import { createFakeExtensionContext, disposeFakeExtensionContext } from "../testHelpers";
import { codeBuildMock } from "../awsMocks";

const token = new vscode.CancellationTokenSource().token;

function invokeOptions(input: TriggerBuildToolInput): vscode.LanguageModelToolInvocationOptions<TriggerBuildToolInput> {
    return { input, toolInvocationToken: undefined };
}

function parseResult(result: vscode.LanguageModelToolResult): any {
    const part = result.content[0] as vscode.LanguageModelTextPart;
    return JSON.parse(part.value);
}

describe("agent/tools/triggerBuildTool", () => {
    let store: AppStore;
    let context: vscode.ExtensionContext;
    let tool: TriggerBuildTool;

    beforeEach(() => {
        codeBuildMock.reset();
        store = createAppStore();
        context = createFakeExtensionContext();
        tool = new TriggerBuildTool(context, store);
    });

    afterEach(() => {
        disposeFakeExtensionContext(context);
    });

    it("rejects a missing project_name without calling AWS", async () => {
        store.setCurrentProfile("dev");
        const result = parseResult(
            await tool.invoke(invokeOptions({ project_name: "  " }), token)
        );

        assert.equal(result.ok, false);
        assert.equal(result.errorType, "VALIDATION_ERROR");
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
    });

    it("returns NO_SELECTION without calling AWS when no profile is given or selected", async () => {
        const result = parseResult(
            await tool.invoke(invokeOptions({ project_name: "demo" }), token)
        );

        assert.equal(result.ok, false);
        assert.equal(result.errorType, "NO_SELECTION");
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
    });

    it("uses the user's current BuildCompanion selection when profile/region are omitted, without revealing the profile name", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).resolves({
            build: { id: "demo:1", projectName: "demo", buildStatus: "IN_PROGRESS" }
        });
        store.setCurrentProfile("acme-prod-admin");
        store.setCurrentRegion("eu-west-1");

        const rawResult = await tool.invoke(invokeOptions({ project_name: "demo" }), token);
        const result = parseResult(rawResult);

        assert.equal(result.ok, true);
        assert.equal(result.usedCurrentSelection, true);
        assert.equal(result.region, "eu-west-1");
        assert.equal(result.profile, undefined);
        assert.doesNotMatch((rawResult.content[0] as vscode.LanguageModelTextPart).value, /acme-prod-admin/);
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 1);
        assert.ok(store.getState().activeBuilds.some((build) => build.id === "demo:1"));
    });

    it("keeps a selection-derived profile name out of error messages sent to the model", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
        store.setCurrentProfile("acme-prod-admin");

        const rawResult = await tool.invoke(invokeOptions({ project_name: "demo" }), token);
        const result = parseResult(rawResult);

        assert.equal(result.errorType, "PERMISSION_DENIED");
        assert.match(result.message, /the current BuildCompanion profile/);
        assert.doesNotMatch((rawResult.content[0] as vscode.LanguageModelTextPart).value, /acme-prod-admin/);
    });

    it("keeps a selection-derived profile name out of a BLOCKED result", async () => {
        store.setCurrentProfile("acme-prod-admin");
        store.blockDestructiveActionsForScope("acme-prod-admin", "us-east-1", "Listing projects failed for profile acme-prod-admin");

        const rawResult = await tool.invoke(invokeOptions({ project_name: "demo" }), token);

        assert.equal(parseResult(rawResult).errorType, "BLOCKED");
        assert.doesNotMatch((rawResult.content[0] as vscode.LanguageModelTextPart).value, /acme-prod-admin/);
    });

    it("rejects an explicit profile BuildCompanion doesn't know, without listing the real ones", async () => {
        store.setProfiles([{ name: "dev" }, { name: "acme-prod-admin" }]);

        const rawResult = await tool.invoke(invokeOptions({ profile: "guessed-prod", region: "us-east-1", project_name: "demo" }), token);
        const text = (rawResult.content[0] as vscode.LanguageModelTextPart).value;

        assert.equal(parseResult(rawResult).errorType, "VALIDATION_ERROR");
        assert.doesNotMatch(text, /acme-prod-admin|"dev"/);
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
    });

    it("refuses with SCOPE_CHANGED if the selection changes between the confirmation and the build", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).resolves({ build: { id: "demo:1", projectName: "demo", buildStatus: "IN_PROGRESS" } });
        store.setCurrentProfile("dev");
        store.setCurrentRegion("us-east-1");

        await tool.prepareInvocation({ input: { project_name: "demo" } }, token);
        store.setCurrentProfile("prod");

        const result = parseResult(await tool.invoke(invokeOptions({ project_name: "demo" }), token));

        assert.equal(result.ok, false);
        assert.equal(result.errorType, "SCOPE_CHANGED");
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
    });

    it("requires an explicit profile and region when requireExplicitScopeForBuilds is on", async () => {
        const config = vscode.workspace.getConfiguration("codebuild");
        await config.update("agentTools.requireExplicitScopeForBuilds", true, vscode.ConfigurationTarget.Global);
        try {
            store.setCurrentProfile("dev");
            const result = parseResult(await tool.invoke(invokeOptions({ project_name: "demo" }), token));

            assert.equal(result.errorType, "VALIDATION_ERROR");
            assert.match(result.message, /explicitly/);
            assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
        } finally {
            await config.update("agentTools.requireExplicitScopeForBuilds", undefined, vscode.ConfigurationTarget.Global);
        }
    });

    it("prepareInvocation shows the user the real selected profile and region and marks them as the current selection", async () => {
        store.setCurrentProfile("acme-prod-admin");
        store.setCurrentRegion("eu-west-1");

        const prepared = await tool.prepareInvocation({ input: { project_name: "demo" } }, token);
        const message = prepared?.confirmationMessages?.message;
        const messageText = typeof message === "string" ? message : message?.value ?? "";

        assert.match(messageText, /acme-prod-admin/);
        assert.match(messageText, /eu-west-1/);
        assert.match(messageText, /current BuildCompanion selection/);
    });

    it("starts a build using the explicit input profile/region, ignoring a different current store scope", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).resolves({
            build: { id: "demo:1", projectName: "demo", buildStatus: "IN_PROGRESS" }
        });

        // Deliberately different from the tool's input: an explicitly named profile always
        // wins over the user's current selection.
        store.setCurrentProfile("some-other-profile");

        const result = parseResult(
            await tool.invoke(invokeOptions({ profile: "dev", region: "us-east-1", project_name: "demo", branch: "main" }), token)
        );

        assert.equal(result.ok, true);
        assert.equal(result.buildId, "demo:1");
        assert.equal(result.profile, "dev");
        assert.equal(result.region, "us-east-1");
        assert.equal(result.usedCurrentSelection, false);
        assert.equal(result.projectName, "demo");

        const startInput = codeBuildMock.commandCalls(StartBuildCommand)[0].args[0].input;
        assert.equal(startInput.sourceVersion, "main");
        assert.ok(startInput.idempotencyToken && startInput.idempotencyToken.length > 0);

        // Must land in the shared AppStore exactly like a human-triggered build, so Active
        // Builds/Failed Builds/TreeView stay correct regardless of trigger source.
        assert.ok(store.getState().activeBuilds.some((build) => build.id === "demo:1"));
        assert.equal(store.isExtensionTriggeredBuild("demo:1"), true);
    });

    it("returns ALREADY_IN_PROGRESS without starting a second build when one is already running", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: ["demo:existing"] });
        codeBuildMock.on(BatchGetBuildsCommand).resolves({
            builds: [{ id: "demo:existing", projectName: "demo", buildStatus: "IN_PROGRESS" }]
        });

        const result = parseResult(
            await tool.invoke(invokeOptions({ profile: "dev", region: "us-east-1", project_name: "demo" }), token)
        );

        assert.equal(result.ok, false);
        assert.equal(result.errorType, "ALREADY_IN_PROGRESS");
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
    });

    it("returns BLOCKED without calling AWS when destructive actions are blocked for the scope", async () => {
        store.blockDestructiveActionsForScope("dev", "us-east-1", "project listing failed");

        const result = parseResult(
            await tool.invoke(invokeOptions({ profile: "dev", region: "us-east-1", project_name: "demo" }), token)
        );

        assert.equal(result.ok, false);
        assert.equal(result.errorType, "BLOCKED");
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
        assert.equal(codeBuildMock.commandCalls(ListBuildsForProjectCommand).length, 0);
    });

    it("returns PERMISSION_DENIED with the required IAM permission when StartBuild is denied", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));

        const result = parseResult(
            await tool.invoke(invokeOptions({ profile: "dev", region: "us-east-1", project_name: "demo" }), token)
        );

        assert.equal(result.ok, false);
        assert.equal(result.errorType, "PERMISSION_DENIED");
        assert.deepEqual(result.requiredPermissions, ["codebuild:StartBuild"]);
        // Never the raw error text, matching getUserFriendlyErrorMessage's redaction guarantees.
        assert.doesNotMatch(result.message, /denied$/);
    });

    it("never leaks a raw AWS error message into the result", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).rejects(new Error("arn:aws:iam::123456789012:role/Example internal failure"));

        const result = parseResult(
            await tool.invoke(invokeOptions({ profile: "dev", region: "us-east-1", project_name: "demo" }), token)
        );

        assert.equal(result.ok, false);
        assert.doesNotMatch(result.message, /arn:aws/);
        assert.doesNotMatch(result.message, /123456789012/);
    });

    it("blocks a second concurrent call for the same scope with ALREADY_IN_PROGRESS and only starts one build", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).resolves({
            build: { id: "demo:1", projectName: "demo", buildStatus: "IN_PROGRESS" }
        });

        const input: TriggerBuildToolInput = { profile: "dev", region: "us-east-1", project_name: "demo" };

        // Deliberately not awaited individually: both invoke() calls' synchronous prefix (through
        // the single-flight lock acquisition) runs before either yields on its first `await`, so
        // the second call's lock check deterministically sees the first call's lock.
        const firstCall = tool.invoke(invokeOptions(input), token);
        const secondCall = tool.invoke(invokeOptions(input), token);

        const [firstResult, secondResult] = (await Promise.all([firstCall, secondCall])).map(parseResult);

        const results = [firstResult, secondResult];
        const successes = results.filter((result) => result.ok === true);
        const lockErrors = results.filter((result) => result.ok === false && result.errorType === "ALREADY_IN_PROGRESS");

        assert.equal(successes.length, 1, "exactly one of the two concurrent calls should succeed");
        assert.equal(lockErrors.length, 1, "the other call should be rejected as already in flight");
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 1);
    });

    it("prepareInvocation states the literal resolved profile/region/project/branch", async () => {
        const prepared = await tool.prepareInvocation(
            { input: { profile: "dev", region: "us-east-1", project_name: "demo", branch: "release/1.0" } },
            token
        );

        const message = prepared?.confirmationMessages?.message;
        const messageText = typeof message === "string" ? message : message?.value ?? "";

        assert.match(messageText, /dev/);
        assert.match(messageText, /us-east-1/);
        assert.match(messageText, /demo/);
        assert.match(messageText, /release\/1\.0/);
    });
});
