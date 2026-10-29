import * as assert from "node:assert/strict";
import * as sinon from "sinon";
import { BatchGetBuildsCommand } from "@aws-sdk/client-codebuild";
import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fetchFullBuildLog, isLogStreamingCancellationError, sanitizeLogMessageForDisplay, streamBuildLogs } from "../../aws/logsService";
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

    describe("streamBuildLogs status-check throttling", () => {
        let clock: sinon.SinonFakeTimers;

        beforeEach(() => {
            codeBuildMock.reset();
            cloudWatchLogsMock.reset();
            clock = sinon.useFakeTimers();
        });

        afterEach(() => {
            clock.restore();
        });

        it("checks build status on only some idle polls instead of every single one while the build is still running", async () => {
            codeBuildMock.on(BatchGetBuildsCommand).resolves({
                builds: [{
                    id: "demo:123",
                    projectName: "demo",
                    buildStatus: "IN_PROGRESS",
                    logs: { groupName: "/aws/codebuild/demo", streamName: "demo-stream" }
                }]
            });
            // A stable token with no events simulates a build that's quiet (still running,
            // nothing new to show) for many consecutive polls in a row.
            cloudWatchLogsMock.on(GetLogEventsCommand).resolves({ events: [], nextForwardToken: "token-a" });

            const controller = new AbortController();
            const streamPromise = streamBuildLogs("dev", "us-east-1", "demo:123", {
                signal: controller.signal,
                pollIntervalMs: 2000
            });

            // Drive 8 idle polls worth of (simulated) time without the build ever finishing.
            for (let i = 0; i < 8; i += 1) {
                await clock.tickAsync(2000);
            }

            controller.abort();
            await clock.tickAsync(0);
            await assert.rejects(streamPromise, (error: unknown) => isLogStreamingCancellationError(error));

            const totalCalls = codeBuildMock.commandCalls(BatchGetBuildsCommand).length;
            // 1 call resolves the initial log location; checking on every one of the 8 idle
            // polls afterward (the old behavior) would add 8 more (9 total). Throttling to every
            // other idle poll should land roughly around 1 + 4, comfortably under that, while
            // still checking more than once (i.e. still checking periodically, not never).
            assert.ok(
                totalCalls >= 3 && totalCalls <= 6,
                `expected a throttled call count (roughly 1 initial + ~4 checks), got ${totalCalls}`
            );
        });

        it("stops checking build status once a terminal state is confirmed, instead of re-checking on every remaining idle poll", async () => {
            codeBuildMock
                .on(BatchGetBuildsCommand)
                .resolvesOnce({
                    // Initial log-location resolution: still running.
                    builds: [{
                        id: "demo:123",
                        projectName: "demo",
                        buildStatus: "IN_PROGRESS",
                        logs: { groupName: "/aws/codebuild/demo", streamName: "demo-stream" }
                    }]
                })
                .resolves({
                    // Every in-loop check from here on: already finished.
                    builds: [{ id: "demo:123", projectName: "demo", buildStatus: "SUCCEEDED" }]
                });
            cloudWatchLogsMock.on(GetLogEventsCommand).resolves({ events: [], nextForwardToken: "token-a" });

            const resultPromise = streamBuildLogs("dev", "us-east-1", "demo:123", { pollIntervalMs: 2000 });

            // Enough idle polls for the throttled check to have run at least once and observed
            // the now-SUCCEEDED status (and, since the log token has stopped advancing too, for
            // the stream to have already ended on its own).
            for (let i = 0; i < 4; i += 1) {
                await clock.tickAsync(2000);
            }

            const callsOnceTerminalConfirmed = codeBuildMock.commandCalls(BatchGetBuildsCommand).length;
            assert.ok(
                callsOnceTerminalConfirmed >= 2,
                "expected at least one in-loop status check in addition to the initial one"
            );

            // A terminal build can't revert to running, so even several more idle polls'
            // worth of time shouldn't trigger any further status checks.
            for (let i = 0; i < 4; i += 1) {
                await clock.tickAsync(2000);
            }

            assert.equal(
                codeBuildMock.commandCalls(BatchGetBuildsCommand).length,
                callsOnceTerminalConfirmed,
                "no further status checks should happen once a terminal build state is already confirmed"
            );

            await resultPromise;
        });
    });
});
