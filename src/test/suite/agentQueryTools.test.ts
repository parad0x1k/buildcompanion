import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { BatchGetBuildsCommand, ListBuildsForProjectCommand, ListProjectsCommand } from "@aws-sdk/client-codebuild";
import { GetBuildStatusTool, type GetBuildStatusToolInput } from "../../agent/tools/getBuildStatusTool";
import { ListProjectsTool, type ListProjectsToolInput } from "../../agent/tools/listProjectsTool";
import { ListRecentBuildsTool, type ListRecentBuildsToolInput } from "../../agent/tools/listRecentBuildsTool";
import { createAppStore, type AppStore } from "../../state/store";
import { createFakeExtensionContext, disposeFakeExtensionContext } from "../testHelpers";
import { codeBuildMock } from "../awsMocks";

const token = new vscode.CancellationTokenSource().token;

function parseResult(result: vscode.LanguageModelToolResult): any {
    const part = result.content[0] as vscode.LanguageModelTextPart;
    return JSON.parse(part.value);
}

describe("agent/tools read-only query tools", () => {
    let context: vscode.ExtensionContext;
    let store: AppStore;

    beforeEach(() => {
        codeBuildMock.reset();
        context = createFakeExtensionContext();
        store = createAppStore();
    });

    afterEach(() => {
        disposeFakeExtensionContext(context);
        store.dispose();
    });

    describe("ListProjectsTool", () => {
        it("returns NO_SELECTION when no profile is given or selected", async () => {
            const tool = new ListProjectsTool(context, store);
            const result = parseResult(
                await tool.invoke({ input: { profile: "", region: "us-east-1" } as ListProjectsToolInput, toolInvocationToken: undefined }, token)
            );
            assert.equal(result.ok, false);
            assert.equal(result.errorType, "NO_SELECTION");
            assert.equal(codeBuildMock.commandCalls(ListProjectsCommand).length, 0);
        });

        it("lists projects for the user's current selection when called with no arguments, withholding the profile name", async () => {
            codeBuildMock.on(ListProjectsCommand).resolves({ projects: ["api"] });
            store.setCurrentProfile("acme-prod-admin");
            store.setCurrentRegion("ap-south-1");
            const tool = new ListProjectsTool(context, store);

            const raw = await tool.invoke({ input: {}, toolInvocationToken: undefined }, token);
            const result = parseResult(raw);

            assert.equal(result.ok, true);
            assert.equal(result.usedCurrentSelection, true);
            assert.equal(result.region, "ap-south-1");
            assert.equal(result.profile, undefined);
            assert.deepEqual(result.projects, [{ name: "api" }]);
            assert.doesNotMatch((raw.content[0] as vscode.LanguageModelTextPart).value, /acme-prod-admin/);
        });

        it("returns the project list for the given explicit profile/region", async () => {
            codeBuildMock.on(ListProjectsCommand).resolves({ projects: ["zeta", "alpha"] });
            const tool = new ListProjectsTool(context, store);

            const result = parseResult(
                await tool.invoke({ input: { profile: "dev", region: "us-east-1" }, toolInvocationToken: undefined }, token)
            );

            assert.equal(result.ok, true);
            assert.equal(result.profile, "dev");
            assert.equal(result.region, "us-east-1");
            assert.deepEqual(result.projects.map((project: { name: string }) => project.name), ["alpha", "zeta"]);
        });

        it("surfaces a structured PERMISSION_DENIED result instead of a raw AWS error", async () => {
            codeBuildMock.on(ListProjectsCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
            const tool = new ListProjectsTool(context, store);

            const result = parseResult(
                await tool.invoke({ input: { profile: "dev", region: "us-east-1" }, toolInvocationToken: undefined }, token)
            );

            assert.equal(result.ok, false);
            assert.equal(result.errorType, "PERMISSION_DENIED");
            assert.deepEqual(result.requiredPermissions, ["codebuild:ListProjects"]);
        });
    });

    describe("GetBuildStatusTool", () => {
        it("rejects an empty build_ids array", async () => {
            const tool = new GetBuildStatusTool(context, store);
            const result = parseResult(
                await tool.invoke(
                    { input: { profile: "dev", region: "us-east-1", build_ids: [] }, toolInvocationToken: undefined },
                    token
                )
            );
            assert.equal(result.ok, false);
            assert.equal(result.errorType, "VALIDATION_ERROR");
        });

        it("rejects more than 100 build_ids without calling AWS", async () => {
            const tool = new GetBuildStatusTool(context, store);
            const tooMany = Array.from({ length: 101 }, (_, index) => `demo:${index}`);

            const result = parseResult(
                await tool.invoke(
                    { input: { profile: "dev", region: "us-east-1", build_ids: tooMany }, toolInvocationToken: undefined },
                    token
                )
            );

            assert.equal(result.ok, false);
            assert.equal(result.errorType, "VALIDATION_ERROR");
            assert.equal(codeBuildMock.commandCalls(BatchGetBuildsCommand).length, 0);
        });

        it("reports a missing build ID as found: false without failing the whole call", async () => {
            codeBuildMock.on(BatchGetBuildsCommand).resolves({
                builds: [{ id: "demo:1", projectName: "demo", buildStatus: "SUCCEEDED" }]
            });
            const tool = new GetBuildStatusTool(context, store);

            const input: GetBuildStatusToolInput = { profile: "dev", region: "us-east-1", build_ids: ["demo:1", "demo:missing"] };
            const result = parseResult(await tool.invoke({ input, toolInvocationToken: undefined }, token));

            assert.equal(result.ok, true);
            const byId = Object.fromEntries(result.builds.map((build: { buildId: string }) => [build.buildId, build]));
            assert.equal(byId["demo:1"].found, true);
            assert.equal(byId["demo:1"].status, "SUCCEEDED");
            assert.equal(byId["demo:missing"].found, false);
        });
    });

    describe("GetBuildStatusTool with the current selection", () => {
        it("fetches status in the user's selected scope when profile/region are omitted", async () => {
            codeBuildMock.on(BatchGetBuildsCommand).resolves({
                builds: [{ id: "demo:1", projectName: "demo", buildStatus: "IN_PROGRESS" }]
            });
            store.setCurrentProfile("dev");
            const tool = new GetBuildStatusTool(context, store);

            const result = parseResult(
                await tool.invoke({ input: { build_ids: ["demo:1"] }, toolInvocationToken: undefined }, token)
            );

            assert.equal(result.ok, true);
            assert.equal(result.usedCurrentSelection, true);
            assert.equal(result.builds[0].status, "IN_PROGRESS");
        });
    });

    describe("ListRecentBuildsTool", () => {
        it("fetches history in the user's selected scope when profile/region are omitted", async () => {
            codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: ["demo:1"] });
            codeBuildMock.on(BatchGetBuildsCommand).resolves({
                builds: [{ id: "demo:1", projectName: "demo", buildStatus: "SUCCEEDED" }]
            });
            store.setCurrentProfile("dev");
            const tool = new ListRecentBuildsTool(context, store);

            const result = parseResult(
                await tool.invoke({ input: { project_name: "demo" }, toolInvocationToken: undefined }, token)
            );

            assert.equal(result.ok, true);
            assert.equal(result.usedCurrentSelection, true);
            assert.equal(result.builds.length, 1);
        });

        it("rejects missing required fields", async () => {
            const tool = new ListRecentBuildsTool(context, store);
            const result = parseResult(
                await tool.invoke(
                    { input: { profile: "dev", region: "us-east-1", project_name: "" } as ListRecentBuildsToolInput, toolInvocationToken: undefined },
                    token
                )
            );
            assert.equal(result.ok, false);
            assert.equal(result.errorType, "VALIDATION_ERROR");
        });

        it("clamps an over-limit request to 100 and still chunks BatchGetBuilds correctly", async () => {
            const totalIds = Array.from({ length: 150 }, (_, index) => `demo:${index}`);
            codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: totalIds });
            codeBuildMock.on(BatchGetBuildsCommand).callsFake((input: { ids?: string[] }) => ({
                builds: (input.ids ?? []).map((id) => ({ id, projectName: "demo", buildStatus: "SUCCEEDED" as const }))
            }));

            const tool = new ListRecentBuildsTool(context, store);
            const input: ListRecentBuildsToolInput = { profile: "dev", region: "us-east-1", project_name: "demo", limit: 500 };
            const result = parseResult(await tool.invoke({ input, toolInvocationToken: undefined }, token));

            assert.equal(result.ok, true);
            assert.equal(result.builds.length, 100);
            assert.equal(result.truncated, true);
        });

        it("reports truncated: false when fewer builds exist than the limit", async () => {
            codeBuildMock.on(ListBuildsForProjectCommand).resolves({ ids: ["demo:1", "demo:2"] });
            codeBuildMock.on(BatchGetBuildsCommand).resolves({
                builds: [
                    { id: "demo:1", projectName: "demo", buildStatus: "SUCCEEDED" },
                    { id: "demo:2", projectName: "demo", buildStatus: "FAILED" }
                ]
            });

            const tool = new ListRecentBuildsTool(context, store);
            const input: ListRecentBuildsToolInput = { profile: "dev", region: "us-east-1", project_name: "demo", limit: 20 };
            const result = parseResult(await tool.invoke({ input, toolInvocationToken: undefined }, token));

            assert.equal(result.ok, true);
            assert.equal(result.builds.length, 2);
            assert.equal(result.truncated, false);
        });
    });
});
