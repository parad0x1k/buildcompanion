import * as assert from "node:assert/strict";
import { extractErrorSummary } from "../../aws/errorExtractor";

describe("aws/errorExtractor", () => {
    it("returns a fallback message when no error heuristics match", () => {
        const summary = extractErrorSummary([
            "Installing dependencies...",
            "Running unit tests...",
            "All tests passed"
        ]);

        assert.deepEqual(summary, ["Build failed, but no clear error lines were detected in recent logs."]);
    });

    it("extracts lines matching known error heuristics", () => {
        const summary = extractErrorSummary([
            "npm install",
            "added 120 packages",
            "npm ERR! missing script: build",
            "exit status 1"
        ]);

        assert.deepEqual(summary, ["npm ERR! missing script: build", "exit status 1"]);
    });

    it("caps the summary at maxSummaryLines, keeping the most recent matches", () => {
        const lines = Array.from({ length: 10 }, (_, index) => `ERROR: failure number ${index}`);
        const summary = extractErrorSummary(lines, { maxSummaryLines: 3 });

        assert.equal(summary.length, 3);
        assert.deepEqual(summary, [
            "ERROR: failure number 7",
            "ERROR: failure number 8",
            "ERROR: failure number 9"
        ]);
    });

    it("only scans the bounded recent-line window (maxInputLines)", () => {
        const lines = [
            "fatal: this old error should be ignored",
            ...Array.from({ length: 10 }, () => "all clear, nothing to report")
        ];

        const summary = extractErrorSummary(lines, { maxInputLines: 5 });

        assert.deepEqual(summary, ["Build failed, but no clear error lines were detected in recent logs."]);
    });

    it("deduplicates repeated matched lines while preserving order", () => {
        const summary = extractErrorSummary([
            "ERROR: disk full",
            "retrying...",
            "ERROR: disk full",
            "ERROR: giving up"
        ]);

        assert.deepEqual(summary, ["ERROR: disk full", "ERROR: giving up"]);
    });

    it("adds one nearby context line when exactly one unique match is found", () => {
        const summary = extractErrorSummary([
            "Compiling module foo.ts",
            "Exception: unexpected token"
        ]);

        assert.deepEqual(summary, ["Compiling module foo.ts", "Exception: unexpected token"]);
    });

    it("normalizes tabs and repeated whitespace in matched lines", () => {
        const summary = extractErrorSummary(["ERROR:\t\tsomething   broke"]);
        assert.deepEqual(summary, ["ERROR: something broke"]);
    });
});
