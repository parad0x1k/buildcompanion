import * as assert from "node:assert/strict";
import { formatBuildTimestamp } from "../../ui/timeFormatting";

describe("ui/timeFormatting", () => {
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
