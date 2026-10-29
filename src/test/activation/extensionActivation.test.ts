import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

// __dirname at runtime is out/test/activation; three levels up is the repo root's package.json.
const manifest = require(path.join(__dirname, "..", "..", "..", "package.json")) as {
    name: string;
    publisher: string;
    contributes: { commands: Array<{ command: string }> };
};
const extensionId = `${manifest.publisher}.${manifest.name}`;

/**
 * Validates the *actual packaged* entry point (package.json#main, the esbuild-bundled
 * dist/extension.js - see esbuild.js) by really activating the extension through VS Code's
 * extension host, rather than unit-testing internal functions directly. This is what proves
 * bundling didn't break module resolution for any of the extension's dependencies (notably
 * @aws-sdk/*), which a successful `tsc`/`esbuild` build alone would not guarantee.
 *
 * Runs as its own isolated test profile (see the "activation" config in .vscode-test.mjs) in a
 * separate Extension Host process from the "unitTests" profile: command-registration.test.ts
 * deliberately leaves its fake-context command registrations active for the rest of its
 * process, which would collide with a real activate() registering the same command ids.
 */
describe("extension activation", () => {
    it("activates the packaged dist/extension.js entry point without throwing", async function () {
        this.timeout(20000);

        const extension = vscode.extensions.getExtension(extensionId);
        assert.ok(extension, `expected extension '${extensionId}' to be discoverable`);

        await extension!.activate();

        assert.equal(extension!.isActive, true);
    });

    it("registers every command declared in package.json after activating", async () => {
        const registeredCommands = await vscode.commands.getCommands(true);

        for (const { command } of manifest.contributes.commands) {
            assert.ok(
                registeredCommands.includes(command),
                `Expected command '${command}' to be registered after real activation`
            );
        }
    });
});
