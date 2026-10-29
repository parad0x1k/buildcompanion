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

    it("rejects missing/empty required fields without calling AWS", async () => {
        const result = parseResult(
            await tool.invoke(invokeOptions({ profile: "", region: "us-east-1", project_name: "demo" }), token)
        );

        assert.equal(result.ok, false);
        assert.equal(result.errorType, "VALIDATION_ERROR");
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
    });

    it("starts a build using the explicit input profile/region, ignoring a different current store scope", async () => {
        codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: [] });
        codeBuildMock.on(StartBuildCommand).resolves({
            build: { id: "demo:1", projectName: "demo", buildStatus: "IN_PROGRESS" }
        });

        // Deliberately different from the tool's input, to prove it never falls back to
        // ambient store state the way the interactive triggerBuild.ts command does.
        store.setCurrentProfile("some-other-profile");

        const result = parseResult(
            await tool.invoke(invokeOptions({ profile: "dev", region: "us-east-1", project_name: "demo", branch: "main" }), token)
        );

        assert.equal(result.ok, true);
        assert.equal(result.buildId, "demo:1");
        assert.equal(result.profile, "dev");
        assert.equal(result.region, "us-east-1");
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
