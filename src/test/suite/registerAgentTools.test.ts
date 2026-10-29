import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { isAgentToolsEnabled, registerAgentTools } from "../../agent/registerAgentTools";
import { createAppStore } from "../../state/store";
import { createFakeExtensionContext, disposeFakeExtensionContext } from "../testHelpers";

const TOOL_NAMES = [
    "codebuild_trigger_build",
    "codebuild_list_projects",
    "codebuild_get_build_status",
    "codebuild_list_recent_builds"
];

async function setAgentToolsEnabled(value: boolean | undefined): Promise<void> {
    await vscode.workspace.getConfiguration("codebuild").update("agentTools.enabled", value, vscode.ConfigurationTarget.Global);
}

// `vscode.lm.tools` reflects every tool *declared* in any loaded extension's package.json
// (including this one, since the test harness loads the compiled manifest), regardless of
// whether `vscode.lm.registerTool` was actually called for it at runtime - so it cannot be used
// to verify this module's enable/disable conditional logic. Stubbing `registerTool` itself is
// the reliable way to verify that logic directly: whether it's called, with which names, and
// whether the disposables it returns get disposed on a live toggle-off.
describe("agent/registerAgentTools", () => {
    let registerToolStub: sinon.SinonStub;
    let disposeStubs: sinon.SinonSpy[];

    beforeEach(() => {
        disposeStubs = [];
        registerToolStub = sinon.stub(vscode.lm, "registerTool").callsFake(() => {
            const disposeSpy = sinon.spy();
            disposeStubs.push(disposeSpy);
            return { dispose: disposeSpy };
        });
    });

    afterEach(async () => {
        registerToolStub.restore();
        await setAgentToolsEnabled(undefined);
    });

    it("defaults to disabled", () => {
        assert.equal(isAgentToolsEnabled(), false);
    });

    it("does not call registerTool when the setting is off", () => {
        const store = createAppStore();
        const context = createFakeExtensionContext();
        const disposable = registerAgentTools(context, store);

        try {
            assert.equal(registerToolStub.called, false);
        } finally {
            disposable.dispose();
            disposeFakeExtensionContext(context);
        }
    });

    it("calls registerTool for all four declared tool names when the setting is on", async () => {
        await setAgentToolsEnabled(true);

        const store = createAppStore();
        const context = createFakeExtensionContext();
        const disposable = registerAgentTools(context, store);

        try {
            const registeredNames = registerToolStub.getCalls().map((call) => call.args[0]);
            assert.deepEqual(registeredNames.sort(), [...TOOL_NAMES].sort());
        } finally {
            disposable.dispose();
            disposeFakeExtensionContext(context);
        }
    });

    it("disposes the registered tools when the setting is toggled off live, without re-registering on dispose", async function () {
        this.timeout(10000);

        await setAgentToolsEnabled(true);

        const store = createAppStore();
        const context = createFakeExtensionContext();
        const disposable = registerAgentTools(context, store);

        try {
            assert.equal(registerToolStub.callCount, TOOL_NAMES.length);

            await setAgentToolsEnabled(false);
            // onDidChangeConfiguration fires asynchronously; give it a turn to process.
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.ok(disposeStubs.every((spy) => spy.called), "every previously-registered tool should be disposed");
            assert.equal(registerToolStub.callCount, TOOL_NAMES.length, "disabling must not re-register");
        } finally {
            disposable.dispose();
            disposeFakeExtensionContext(context);
        }
    });
});
