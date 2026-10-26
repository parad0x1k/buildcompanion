import * as assert from "node:assert/strict";
import { formatBuildStatusLabel } from "../../ui/statusLabels";

describe("ui/statusLabels", () => {
    describe("formatBuildStatusLabel", () => {
        it("renders each known CodeBuild status as a short human-readable label", () => {
            assert.equal(formatBuildStatusLabel("IN_PROGRESS"), "In Progress");
            assert.equal(formatBuildStatusLabel("SUCCEEDED"), "Succeeded");
            assert.equal(formatBuildStatusLabel("FAILED"), "Failed");
            assert.equal(formatBuildStatusLabel("STOPPED"), "Stopped");
            assert.equal(formatBuildStatusLabel("FAULT"), "Fault");
            assert.equal(formatBuildStatusLabel("TIMED_OUT"), "Timed Out");
        });

        it("falls back to a generic title-case conversion for unrecognized statuses", () => {
            assert.equal(formatBuildStatusLabel("SOME_NEW_STATUS"), "Some New Status");
        });

        it("returns 'Unknown' for missing/empty/whitespace-only status values", () => {
            assert.equal(formatBuildStatusLabel(undefined), "Unknown");
            assert.equal(formatBuildStatusLabel(null), "Unknown");
            assert.equal(formatBuildStatusLabel(""), "Unknown");
            assert.equal(formatBuildStatusLabel("   "), "Unknown");
        });

        it("trims surrounding whitespace before matching", () => {
            assert.equal(formatBuildStatusLabel("  SUCCEEDED  "), "Succeeded");
        });
    });
});
