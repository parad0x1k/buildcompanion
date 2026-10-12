import * as assert from "node:assert/strict";
import { StartBuildCommand } from "@aws-sdk/client-codebuild";
import { MAX_BATCH_SELECTED_PROJECTS, MIN_BATCH_DELAY_MS, triggerBuildBatch } from "../../aws/batchTriggerManager";
import { codeBuildMock } from "../awsMocks";

describe("aws/batchTriggerManager", () => {
    beforeEach(() => {
        codeBuildMock.reset();
    });

    it("deduplicates projects by name and triggers each exactly once", async function () {
        this.timeout(10000);
        codeBuildMock.on(StartBuildCommand).callsFake((input: { projectName: string }) => ({
            build: { id: `${input.projectName}:1`, projectName: input.projectName, buildStatus: "IN_PROGRESS" }
        }));

        const triggered: string[] = [];
        const result = await triggerBuildBatch({
            projects: [{ projectName: "a" }, { projectName: "b" }, { projectName: "a" }],
            profile: "dev",
            region: "us-east-1",
            delayMs: MIN_BATCH_DELAY_MS,
            onBuildTriggered: ({ projectName }) => triggered.push(projectName)
        });

        assert.deepEqual(triggered, ["a", "b"]);
        assert.equal(result.successfulBuilds.length, 2);
        assert.equal(result.failedProjects.length, 0);
        assert.equal(result.cancelled, false);
    });

    it("continues the batch after a single project fails to start", async function () {
        this.timeout(10000);
        codeBuildMock.on(StartBuildCommand, { projectName: "bad" }).rejects(
            Object.assign(new Error("denied"), { name: "AccessDeniedException" })
        );
        codeBuildMock.on(StartBuildCommand, { projectName: "good" }).resolves({
            build: { id: "good:1", projectName: "good", buildStatus: "IN_PROGRESS" }
        });

        const result = await triggerBuildBatch({
            projects: [{ projectName: "bad" }, { projectName: "good" }],
            profile: "dev",
            region: "us-east-1",
            delayMs: MIN_BATCH_DELAY_MS
        });

        assert.equal(result.successfulBuilds.length, 1);
        assert.equal(result.successfulBuilds[0].projectName, "good");
        assert.equal(result.failedProjects.length, 1);
        assert.equal(result.failedProjects[0].projectName, "bad");
        assert.equal(result.cancelled, false);
    });

    it("stops triggering further projects once cancelled mid-delay", async function () {
        this.timeout(10000);
        codeBuildMock.on(StartBuildCommand).callsFake((input: { projectName: string }) => ({
            build: { id: `${input.projectName}:1`, projectName: input.projectName, buildStatus: "IN_PROGRESS" }
        }));

        let cancelled = false;
        setTimeout(() => { cancelled = true; }, 200);

        const result = await triggerBuildBatch({
            projects: [{ projectName: "first" }, { projectName: "second" }, { projectName: "third" }],
            profile: "dev",
            region: "us-east-1",
            delayMs: MIN_BATCH_DELAY_MS,
            isCancelled: () => cancelled
        });

        assert.equal(result.cancelled, true);
        assert.equal(result.successfulBuilds.length, 1);
        assert.equal(result.successfulBuilds[0].projectName, "first");
    });

    it("rejects batches larger than MAX_BATCH_SELECTED_PROJECTS", async () => {
        const projects = Array.from({ length: MAX_BATCH_SELECTED_PROJECTS + 1 }, (_, index) => ({
            projectName: `project-${index}`
        }));

        await assert.rejects(() => triggerBuildBatch({
            projects,
            profile: "dev",
            region: "us-east-1",
            delayMs: MIN_BATCH_DELAY_MS
        }));
    });

    it("returns an empty result without calling AWS when given no projects", async () => {
        const result = await triggerBuildBatch({
            projects: [],
            profile: "dev",
            region: "us-east-1",
            delayMs: MIN_BATCH_DELAY_MS
        });

        assert.deepEqual(result, { successfulBuilds: [], failedProjects: [], cancelled: false });
        assert.equal(codeBuildMock.commandCalls(StartBuildCommand).length, 0);
    });
});
