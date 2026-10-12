import * as assert from "node:assert/strict";
import {
    BatchGetBuildsCommand,
    BatchGetProjectsCommand,
    ListProjectsCommand,
    RetryBuildCommand,
    StartBuildCommand,
    UpdateProjectCommand
} from "@aws-sdk/client-codebuild";
import {
    getProjectEnvironmentVariables,
    getBuildStatus,
    listCodeBuildProjects,
    retryBuild,
    setProjectEnvironmentVariables,
    startCodeBuild
} from "../../aws/codebuildService";
import { codeBuildMock } from "../awsMocks";

describe("aws/codebuildService", () => {
    beforeEach(() => {
        codeBuildMock.reset();
    });

    describe("listCodeBuildProjects", () => {
        it("returns projects sorted alphabetically", async () => {
            codeBuildMock.on(ListProjectsCommand).resolves({ projects: ["zeta", "alpha", "mid"] });

            const projects = await listCodeBuildProjects("dev", "us-east-1");

            assert.deepEqual(projects.map((p) => p.name), ["alpha", "mid", "zeta"]);
        });

        it("wraps AWS failures in a friendly, scope-qualified error", async () => {
            codeBuildMock.on(ListProjectsCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));

            await assert.rejects(
                () => listCodeBuildProjects("dev", "us-east-1"),
                (error: Error) => {
                    assert.match(error.message, /missing AWS permissions/);
                    assert.match(error.message, /profile: dev, region: us-east-1/);
                    return true;
                }
            );
        });
    });

    describe("startCodeBuild", () => {
        it("maps a successful StartBuild response to BuildState", async () => {
            codeBuildMock.on(StartBuildCommand).resolves({
                build: { id: "demo:123", projectName: "demo", buildStatus: "IN_PROGRESS" }
            });

            const build = await startCodeBuild("dev", "us-east-1", "demo", "main");

            assert.equal(build.id, "demo:123");
            assert.equal(build.status, "IN_PROGRESS");
            assert.equal(build.profile, "dev");
            assert.equal(build.region, "us-east-1");
        });

        it("omits sourceVersion when no branch is provided", async () => {
            codeBuildMock.on(StartBuildCommand).resolves({
                build: { id: "demo:456", projectName: "demo", buildStatus: "IN_PROGRESS" }
            });

            await startCodeBuild("dev", "us-east-1", "demo");

            const calls = codeBuildMock.commandCalls(StartBuildCommand);
            assert.equal(calls[calls.length - 1].args[0].input.sourceVersion, undefined);
        });
    });

    describe("getBuildStatus", () => {
        it("normalizes unknown/queued statuses to IN_PROGRESS", async () => {
            codeBuildMock.on(BatchGetBuildsCommand).resolves({
                builds: [{ id: "demo:789", projectName: "demo", buildStatus: "SOME_UNKNOWN_STATUS" as never }]
            });

            const build = await getBuildStatus("dev", "us-east-1", "demo:789");

            assert.equal(build?.status, "IN_PROGRESS");
        });

        it("returns null when the build is not found", async () => {
            codeBuildMock.on(BatchGetBuildsCommand).resolves({ builds: [] });
            const build = await getBuildStatus("dev", "us-east-1", "missing");
            assert.equal(build, null);
        });
    });

    describe("retryBuild", () => {
        it("maps a successful RetryBuild response to BuildState, including the resolved source version", async () => {
            codeBuildMock.on(RetryBuildCommand).resolves({
                build: { id: "demo:999", projectName: "demo", buildStatus: "IN_PROGRESS", sourceVersion: "feature/my-branch" }
            });

            const build = await retryBuild("dev", "us-east-1", "demo:111");

            assert.equal(build.id, "demo:999");
            assert.equal(build.status, "IN_PROGRESS");
            assert.equal(build.sourceVersion, "feature/my-branch");

            const calls = codeBuildMock.commandCalls(RetryBuildCommand);
            assert.equal(calls[calls.length - 1].args[0].input.id, "demo:111");
        });

        it("normalizes a missing source version to 'default'", async () => {
            codeBuildMock.on(RetryBuildCommand).resolves({
                build: { id: "demo:1000", projectName: "demo", buildStatus: "IN_PROGRESS" }
            });

            const build = await retryBuild("dev", "us-east-1", "demo:111");

            assert.equal(build.sourceVersion, "default");
        });

        it("surfaces the required IAM permission when access is denied", async () => {
            codeBuildMock.on(RetryBuildCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));

            await assert.rejects(
                () => retryBuild("dev", "us-east-1", "demo:111"),
                (error: Error) => {
                    assert.match(error.message, /codebuild:RetryBuild/);
                    return true;
                }
            );
        });

        it("requires a non-empty build id", async () => {
            await assert.rejects(() => retryBuild("dev", "us-east-1", "   "));
        });
    });

    describe("getProjectEnvironmentVariables", () => {
        it("maps configured environment variables and defaults missing type to PLAINTEXT", async () => {
            codeBuildMock.on(BatchGetProjectsCommand).resolves({
                projects: [{
                    name: "demo",
                    environment: {
                        type: "LINUX_CONTAINER",
                        image: "aws/codebuild/standard:7.0",
                        computeType: "BUILD_GENERAL1_SMALL",
                        environmentVariables: [
                            { name: "NODE_ENV", value: "production" },
                            { name: "DB_SECRET", value: "my-secret-name", type: "SECRETS_MANAGER" }
                        ]
                    }
                }]
            });

            const variables = await getProjectEnvironmentVariables("dev", "us-east-1", "demo");

            assert.deepEqual(variables, [
                { name: "NODE_ENV", value: "production", type: "PLAINTEXT" },
                { name: "DB_SECRET", value: "my-secret-name", type: "SECRETS_MANAGER" }
            ]);
        });

        it("returns an empty array when the project has no environment variables configured", async () => {
            codeBuildMock.on(BatchGetProjectsCommand).resolves({
                projects: [{
                    name: "demo",
                    environment: {
                        type: "LINUX_CONTAINER",
                        image: "aws/codebuild/standard:7.0",
                        computeType: "BUILD_GENERAL1_SMALL"
                    }
                }]
            });

            const variables = await getProjectEnvironmentVariables("dev", "us-east-1", "demo");
            assert.deepEqual(variables, []);
        });

        it("throws a friendly error when the project is not found", async () => {
            codeBuildMock.on(BatchGetProjectsCommand).resolves({ projects: [] });

            await assert.rejects(() => getProjectEnvironmentVariables("dev", "us-east-1", "missing"));
        });
    });

    describe("setProjectEnvironmentVariables", () => {
        it("preserves the rest of the environment config and only replaces environmentVariables", async () => {
            codeBuildMock.on(BatchGetProjectsCommand).resolves({
                projects: [{
                    name: "demo",
                    environment: {
                        type: "LINUX_CONTAINER",
                        image: "aws/codebuild/standard:7.0",
                        computeType: "BUILD_GENERAL1_SMALL",
                        privilegedMode: true,
                        environmentVariables: [{ name: "OLD", value: "old-value" }]
                    }
                }]
            });
            codeBuildMock.on(UpdateProjectCommand).resolves({});

            await setProjectEnvironmentVariables("dev", "us-east-1", "demo", [
                { name: "NEW", value: "new-value", type: "PLAINTEXT" }
            ]);

            const calls = codeBuildMock.commandCalls(UpdateProjectCommand);
            assert.equal(calls.length, 1);
            const input = calls[0].args[0].input;

            assert.equal(input.name, "demo");
            assert.equal(input.environment?.image, "aws/codebuild/standard:7.0");
            assert.equal(input.environment?.computeType, "BUILD_GENERAL1_SMALL");
            assert.equal(input.environment?.privilegedMode, true);
            assert.deepEqual(input.environment?.environmentVariables, [
                { name: "NEW", value: "new-value", type: "PLAINTEXT" }
            ]);
        });

        it("surfaces both required IAM permissions when access is denied", async () => {
            codeBuildMock.on(BatchGetProjectsCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));

            await assert.rejects(
                () => setProjectEnvironmentVariables("dev", "us-east-1", "demo", []),
                (error: Error) => {
                    assert.match(error.message, /codebuild:BatchGetProjects/);
                    assert.match(error.message, /codebuild:UpdateProject/);
                    return true;
                }
            );
        });
    });
});
