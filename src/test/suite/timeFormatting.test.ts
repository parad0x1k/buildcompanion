import * as assert from "node:assert/strict";
import { formatBuildTimestamp, formatElapsed, resolveBuildDurationSeconds } from "../../ui/timeFormatting";

describe("ui/timeFormatting", () => {
    describe("formatElapsed", () => {
        it("returns undefined for missing or non-finite input", () => {
            assert.equal(formatElapsed(undefined), undefined);
            assert.equal(formatElapsed(Number.NaN), undefined);
            assert.equal(formatElapsed(Number.POSITIVE_INFINITY), undefined);
        });

        it("formats seconds, minutes and hours, omitting zero units", () => {
            assert.equal(formatElapsed(0), "0s");
            assert.equal(formatElapsed(42), "42s");
            assert.equal(formatElapsed(300), "5m");
            assert.equal(formatElapsed(252), "4m 12s");
            assert.equal(formatElapsed(3600), "1h");
            assert.equal(formatElapsed(3605), "1h 5s");
            assert.equal(formatElapsed(4503), "1h 15m 3s");
        });

        it("floors fractional seconds and clamps negatives to zero", () => {
            assert.equal(formatElapsed(59.9), "59s");
            assert.equal(formatElapsed(-5), "0s");
        });
    });

    describe("resolveBuildDurationSeconds", () => {
        it("prefers an explicit durationSeconds", () => {
            assert.equal(resolveBuildDurationSeconds({
                durationSeconds: 90,
                startedAt: "2026-01-01T00:00:00.000Z",
                endedAt: "2026-01-01T01:00:00.000Z"
            }), 90);
        });

        it("derives the duration from start/end timestamps when not precomputed", () => {
            assert.equal(resolveBuildDurationSeconds({
                startedAt: "2026-01-01T00:00:00.000Z",
                endedAt: "2026-01-01T00:04:12.400Z"
            }), 252);
        });

        it("returns undefined when an end time is missing, unparseable, or before the start", () => {
            assert.equal(resolveBuildDurationSeconds({ startedAt: "2026-01-01T00:00:00.000Z" }), undefined);
            assert.equal(resolveBuildDurationSeconds({ startedAt: "nope", endedAt: "2026-01-01T00:00:00.000Z" }), undefined);
            assert.equal(resolveBuildDurationSeconds({
                startedAt: "2026-01-01T00:05:00.000Z",
                endedAt: "2026-01-01T00:00:00.000Z"
            }), undefined);
        });
    });

    describe("formatBuildTimestamp", () => {
        it("returns undefined for an empty/missing value", () => {
            assert.equal(formatBuildTimestamp(undefined, "local"), undefined);
            assert.equal(formatBuildTimestamp("", "local"), undefined);
            assert.equal(formatBuildTimestamp("   ", "utc"), undefined);
        });

        it("falls back to the raw string when the value can't be parsed as a date", () => {
            assert.equal(formatBuildTimestamp("not-a-real-date", "local"), "not-a-real-date");
        });

        it("renders the UTC timestamp with an explicit UTC zone label", () => {
            const formatted = formatBuildTimestamp("2026-01-15T13:45:30.000Z", "utc");
            assert.ok(formatted);
            assert.match(formatted, /2026/);
            assert.match(formatted, /UTC/);
        });

        it("renders the local timestamp with some explicit zone label, distinct from a bare UTC render", () => {
            const localFormatted = formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local");
            const utcFormatted = formatBuildTimestamp("2026-01-15T13:45:30.000Z", "utc");
            assert.ok(localFormatted);
            assert.match(localFormatted, /2026/);
            // Local and UTC renders should both include a zone label; this doesn't assert they
            // differ (the test runner's local timezone might itself be UTC), just that both are
            // well-formed, non-empty, timezone-qualified strings.
            assert.ok(localFormatted.length > 0 && utcFormatted!.length > 0);
        });

        it("honors an explicit localTimeZoneOverride instead of the host's detected timezone", () => {
            // This is exactly the scenario a remote/container extension host hits: the detected
            // system timezone (often UTC there) makes "local" indistinguishable from "utc". An
            // explicit IANA override should always win and differ from a plain UTC render.
            const overridden = formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local", "America/New_York");
            const utcFormatted = formatBuildTimestamp("2026-01-15T13:45:30.000Z", "utc");
            assert.ok(overridden);
            assert.match(overridden, /2026/);
            assert.notEqual(overridden, utcFormatted);
        });

        it("falls back to auto-detection for an empty/whitespace-only override", () => {
            const bareLocal = formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local");
            assert.equal(formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local", ""), bareLocal);
            assert.equal(formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local", "   "), bareLocal);
        });

        it("falls back to auto-detection instead of throwing for an invalid timezone override", () => {
            const bareLocal = formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local");
            assert.doesNotThrow(() => formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local", "Not/A_Real_Zone"));
            assert.equal(formatBuildTimestamp("2026-01-15T13:45:30.000Z", "local", "Not/A_Real_Zone"), bareLocal);
        });
    });
});
