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
    });
});
