import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { BatchGetBuildsCommand, ListBuildsForProjectCommand, ListProjectsCommand } from "@aws-sdk/client-codebuild";
import { GetBuildStatusTool, type GetBuildStatusToolInput } from "../../agent/tools/getBuildStatusTool";
import { ListProjectsTool, type ListProjectsToolInput } from "../../agent/tools/listProjectsTool";
import { ListRecentBuildsTool, type ListRecentBuildsToolInput } from "../../agent/tools/listRecentBuildsTool";
import { createFakeExtensionContext, disposeFakeExtensionContext } from "../testHelpers";
import { codeBuildMock } from "../awsMocks";

const token = new vscode.CancellationTokenSource().token;

function parseResult(result: vscode.LanguageModelToolResult): any {
    const part = result.content[0] as vscode.LanguageModelTextPart;
    return JSON.parse(part.value);
}

describe("agent/tools read-only query tools", () => {
    let context: vscode.ExtensionContext;

    beforeEach(() => {
        codeBuildMock.reset();
        context = createFakeExtensionContext();
    });

    afterEach(() => {
        disposeFakeExtensionContext(context);
    });

    describe("ListProjectsTool", () => {
        it("rejects missing required fields", async () => {
            const tool = new ListProjectsTool(context);
            const result = parseResult(
                await tool.invoke({ input: { profile: "", region: "us-east-1" } as ListProjectsToolInput, toolInvocationToken: undefined }, token)
            );
            assert.equal(result.ok, false);
            assert.equal(result.errorType, "VALIDATION_ERROR");
        });

        it("returns the project list for the given explicit profile/region", async () => {
            codeBuildMock.on(ListProjectsCommand).resolves({ projects: ["zeta", "alpha"] });
            const tool = new ListProjectsTool(context);

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
            const tool = new ListProjectsTool(context);

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
            const tool = new GetBuildStatusTool(context);
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
            const tool = new GetBuildStatusTool(context);
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
            const tool = new GetBuildStatusTool(context);

            const input: GetBuildStatusToolInput = { profile: "dev", region: "us-east-1", build_ids: ["demo:1", "demo:missing"] };
            const result = parseResult(await tool.invoke({ input, toolInvocationToken: undefined }, token));

            assert.equal(result.ok, true);
            const byId = Object.fromEntries(result.builds.map((build: { buildId: string }) => [build.buildId, build]));
            assert.equal(byId["demo:1"].found, true);
            assert.equal(byId["demo:1"].status, "SUCCEEDED");
            assert.equal(byId["demo:missing"].found, false);
        });
    });

    describe("ListRecentBuildsTool", () => {
        it("rejects missing required fields", async () => {
            const tool = new ListRecentBuildsTool(context);
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

            const tool = new ListRecentBuildsTool(context);
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

            const tool = new ListRecentBuildsTool(context);
            const input: ListRecentBuildsToolInput = { profile: "dev", region: "us-east-1", project_name: "demo", limit: 20 };
            const result = parseResult(await tool.invoke({ input, toolInvocationToken: undefined }, token));

            assert.equal(result.ok, true);
            assert.equal(result.builds.length, 2);
            assert.equal(result.truncated, false);
        });
    });
});
