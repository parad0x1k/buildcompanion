import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { sanitizeLogValue } from "../../logging/outputChannelManager";

async function setVerboseLogging(enabled: boolean | undefined): Promise<void> {
    await vscode.workspace
        .getConfiguration("codebuild")
        .update("logging.verbose", enabled, vscode.ConfigurationTarget.Global);
}

describe("logging/outputChannelManager", () => {
    afterEach(async () => {
        // Always restore the default (redacted) mode so other test files are unaffected.
        await setVerboseLogging(undefined);
    });

    describe("sanitizeLogValue", () => {
        it("redacts profile/region/buildId kinds by default", async () => {
            await setVerboseLogging(false);

            assert.equal(sanitizeLogValue("my-profile", "profile"), "<profile-redacted>");
            assert.equal(sanitizeLogValue("us-east-1", "region"), "<region-redacted>");
            assert.equal(sanitizeLogValue("project:abc123", "buildId"), "<build-id-redacted>");
        });

        it("does not redact the generic kind", async () => {
            await setVerboseLogging(false);
            assert.equal(sanitizeLogValue("some free-form message", "generic"), "some free-form message");
        });

        it("shows raw values for all kinds when verbose logging is enabled", async () => {
            await setVerboseLogging(true);

            assert.equal(sanitizeLogValue("my-profile", "profile"), "my-profile");
            assert.equal(sanitizeLogValue("us-east-1", "region"), "us-east-1");
            assert.equal(sanitizeLogValue("project:abc123", "buildId"), "project:abc123");
        });

        it("falls back to 'unknown' for empty/undefined values regardless of verbosity", async () => {
            await setVerboseLogging(true);
            assert.equal(sanitizeLogValue(undefined), "unknown");
            assert.equal(sanitizeLogValue(""), "unknown");
            assert.equal(sanitizeLogValue("   "), "unknown");
        });

        it("strips control characters (including ANSI escapes) and collapses whitespace", async () => {
            await setVerboseLogging(true);

            const withAnsiAndControlChars = "normal\x1b[31mred-text\x1b[0m\r\nline2\tindented";
            const sanitized = sanitizeLogValue(withAnsiAndControlChars);

            assert.ok(!sanitized.includes("\x1b"));
            assert.ok(!sanitized.includes("\r"));
            assert.ok(!sanitized.includes("\n"));
            assert.ok(!sanitized.includes("\t"));
            // Each stripped control character (ESC, CR/LF, TAB) collapses to a single space,
            // so the literal (non-control) bracket text that followed each ESC remains intact.
            assert.equal(sanitized, "normal [31mred-text [0m line2 indented");
        });
    });
});
