import * as assert from "node:assert/strict";
import { BatchGetBuildsCommand } from "@aws-sdk/client-codebuild";
import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fetchFullBuildLog, sanitizeLogMessageForDisplay } from "../../aws/logsService";
import { codeBuildMock, cloudWatchLogsMock } from "../awsMocks";

describe("aws/logsService", () => {
    describe("sanitizeLogMessageForDisplay", () => {
        it("strips ANSI color/style escape codes", () => {
            const input = "\u001b[32mnpm\u001b[0m \u001b[1mINFO\u001b[22m installed 42 packages";
            assert.equal(sanitizeLogMessageForDisplay(input), "npm INFO installed 42 packages");
        });

        it("collapses carriage-return progress-bar overwrites to their final state", () => {
            const input = "Downloading [=>   ] 10%\rDownloading [====>] 50%\rDownloading [=====] 100%";
            assert.equal(sanitizeLogMessageForDisplay(input), "Downloading [=====] 100%");
        });

        it("normalizes Windows-style CRLF line endings to LF", () => {
            assert.equal(sanitizeLogMessageForDisplay("line one\r\nline two\r\n"), "line one\nline two\n");
        });

        it("preserves normal unicode/emoji text untouched", () => {
            const input = "Café — build succeeded 🎉";
            assert.equal(sanitizeLogMessageForDisplay(input), input);
        });

        it("drops stray/unrecognized control characters while keeping surrounding text", () => {
            assert.equal(sanitizeLogMessageForDisplay("weird\u001bzjunk here"), "weirdzjunk here");
        });

        it("preserves tabs used for indentation", () => {
            assert.equal(sanitizeLogMessageForDisplay("\tindented line"), "\tindented line");
        });
    });

    describe("fetchFullBuildLog", () => {
        beforeEach(() => {
            codeBuildMock.reset();
            cloudWatchLogsMock.reset();
            codeBuildMock.on(BatchGetBuildsCommand).resolves({
                builds: [{
                    id: "demo:123",
                    projectName: "demo",
                    buildStatus: "SUCCEEDED",
                    logs: { groupName: "/aws/codebuild/demo", streamName: "demo-stream" }
                }]
            });
        });

        it("paginates through multiple pages until the stream catches up, forwarding lines and progress in order", async () => {
            cloudWatchLogsMock
                .on(GetLogEventsCommand)
                .resolvesOnce({
                    events: [{ timestamp: 1000, message: "line one" }, { timestamp: 1001, message: "line two" }],
                    nextForwardToken: "token-a"
                })
                .resolvesOnce({
                    events: [{ timestamp: 1002, message: "line three" }],
                    nextForwardToken: "token-b"
                })
                .resolves({
                    events: [],
                    nextForwardToken: "token-b"
                });

            const receivedLines: string[] = [];
            const progressUpdates: number[] = [];

            const result = await fetchFullBuildLog("dev", "us-east-1", "demo:123", {
                onLines: (lines) => receivedLines.push(...lines),
                onProgress: (count) => progressUpdates.push(count)
            });

            assert.equal(result.status, "SUCCEEDED");
            assert.equal(result.truncated, false);
            assert.equal(result.totalLines, 3);
            assert.ok(receivedLines.some((line) => line.includes("line one")));
            assert.ok(receivedLines.some((line) => line.includes("line two")));
            assert.ok(receivedLines.some((line) => line.includes("line three")));
            assert.deepEqual(progressUpdates, [2, 3]);
        });

        it("stops and marks the result truncated once the configured maxLines cap is reached", async () => {
            cloudWatchLogsMock.on(GetLogEventsCommand).resolves({
                events: [
                    { timestamp: 1000, message: "line one" },
                    { timestamp: 1001, message: "line two" },
                    { timestamp: 1002, message: "line three" },
                    { timestamp: 1003, message: "line four" },
                    { timestamp: 1004, message: "line five" }
                ],
                nextForwardToken: "token-a"
            });

            const receivedLines: string[] = [];
            const result = await fetchFullBuildLog("dev", "us-east-1", "demo:123", {
                maxLines: 3,
                onLines: (lines) => receivedLines.push(...lines)
            });

            assert.equal(result.truncated, true);
            assert.equal(result.totalLines, 3);
            assert.equal(receivedLines.length, 3);
        });

        it("sanitizes ANSI codes out of fetched log lines before they reach the caller", async () => {
            cloudWatchLogsMock
                .on(GetLogEventsCommand)
                .resolvesOnce({
                    events: [{ timestamp: 1000, message: "\u001b[31mERROR\u001b[0m: build failed" }],
                    nextForwardToken: "token-a"
                })
                .resolves({ events: [], nextForwardToken: "token-a" });

            const receivedLines: string[] = [];
            await fetchFullBuildLog("dev", "us-east-1", "demo:123", {
                onLines: (lines) => receivedLines.push(...lines)
            });

            assert.ok(receivedLines.some((line) => line.includes("ERROR: build failed")));
            assert.ok(!receivedLines.some((line) => line.includes("\u001b")));
        });

        it("returns an empty, non-truncated result when the log stream has no events", async () => {
            cloudWatchLogsMock.on(GetLogEventsCommand).resolves({ events: [], nextForwardToken: "token-a" });

            const result = await fetchFullBuildLog("dev", "us-east-1", "demo:123");

            assert.equal(result.totalLines, 0);
            assert.equal(result.truncated, false);
        });

        it("requires a non-empty profile, region, and build id", async () => {
            await assert.rejects(() => fetchFullBuildLog("", "us-east-1", "demo:123"));
            await assert.rejects(() => fetchFullBuildLog("dev", "", "demo:123"));
            await assert.rejects(() => fetchFullBuildLog("dev", "us-east-1", "   "));
        });
    });
});
