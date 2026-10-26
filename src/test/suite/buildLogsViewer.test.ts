import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
    BuildLogsDocumentProvider,
    BUILD_LOGS_URI_SCHEME,
    buildFullLogsDocumentUri,
    buildLogsDocumentUri
} from "../../ui/buildLogsViewer";

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ui/buildLogsViewer", () => {
    describe("buildLogsDocumentUri", () => {
        it("produces a stable, scheme-correct URI for the same build", () => {
            const uriA = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            const uriB = buildLogsDocumentUri("dev", "us-east-1", "demo:123");

            assert.equal(uriA.scheme, BUILD_LOGS_URI_SCHEME);
            assert.equal(uriA.toString(), uriB.toString());
        });

        it("produces distinct URIs for different builds", () => {
            const uriA = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            const uriB = buildLogsDocumentUri("dev", "us-east-1", "demo:456");
            assert.notEqual(uriA.toString(), uriB.toString());
        });
    });

    describe("buildFullLogsDocumentUri", () => {
        it("produces a scheme-correct URI distinct from the tailing log URI for the same build", () => {
            const tailUri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            const fullUri = buildFullLogsDocumentUri("dev", "us-east-1", "demo:123");

            assert.equal(fullUri.scheme, BUILD_LOGS_URI_SCHEME);
            assert.notEqual(fullUri.toString(), tailUri.toString());
        });

        it("produces a stable URI for the same build", () => {
            const uriA = buildFullLogsDocumentUri("dev", "us-east-1", "demo:123");
            const uriB = buildFullLogsDocumentUri("dev", "us-east-1", "demo:123");
            assert.equal(uriA.toString(), uriB.toString());
        });
    });

    describe("BuildLogsDocumentProvider", () => {
        let provider: BuildLogsDocumentProvider;

        beforeEach(() => {
            provider = new BuildLogsDocumentProvider();
        });

        afterEach(() => {
            provider.dispose();
        });

        it("renders a header with build metadata before any lines arrive", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

            const content = provider.provideTextDocumentContent(uri);
            assert.match(content, /Project:\s+demo/);
            assert.match(content, /Profile:\s+dev/);
            assert.match(content, /Region:\s+us-east-1/);
            assert.match(content, /Build ID:\s+demo:123/);
        });

        it("reflects appended lines immediately in provideTextDocumentContent", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

            provider.appendLines(uri, ["line one", "line two"]);

            const content = provider.provideTextDocumentContent(uri);
            assert.match(content, /line one/);
            assert.match(content, /line two/);
        });

        it("coalesces rapid appendLines bursts into a single onDidChange event", async () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

            let fireCount = 0;
            const subscription = provider.onDidChange(() => { fireCount += 1; });

            for (let i = 0; i < 25; i += 1) {
                provider.appendLines(uri, [`burst line ${i}`]);
            }

            await wait(500);
            subscription.dispose();

            assert.equal(fireCount, 1);
        });

        it("fires a second onDidChange event for a new burst after the throttle window elapses", async () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

            let fireCount = 0;
            const subscription = provider.onDidChange(() => { fireCount += 1; });

            provider.appendLines(uri, ["first burst"]);
            await wait(500);
            provider.appendLines(uri, ["second burst"]);
            await wait(500);
            subscription.dispose();

            assert.equal(fireCount, 2);
        });

        it("truncates the oldest lines once the configured maximum is exceeded", async () => {
            const config = vscode.workspace.getConfiguration("codebuild");
            await config.update("logsViewer.maxLines", 500, vscode.ConfigurationTarget.Global);

            try {
                const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
                provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

                const lines = Array.from({ length: 510 }, (_, index) => `line-${index}`);
                provider.appendLines(uri, lines);

                const content = provider.provideTextDocumentContent(uri);
                assert.match(content, /10 earlier line\(s\) truncated/);
                assert.ok(!content.includes("line-0\n"), "oldest retained line should not be line-0");
                assert.ok(content.includes("line-509"), "most recent line must be retained");
            } finally {
                await config.update("logsViewer.maxLines", undefined, vscode.ConfigurationTarget.Global);
            }
        });

        it("never truncates an unbounded (full log) document even past the configured maximum", async () => {
            const config = vscode.workspace.getConfiguration("codebuild");
            await config.update("logsViewer.maxLines", 500, vscode.ConfigurationTarget.Global);

            try {
                const uri = buildFullLogsDocumentUri("dev", "us-east-1", "demo:123");
                provider.open(
                    uri,
                    { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123", mode: "full" },
                    { unbounded: true }
                );

                const lines = Array.from({ length: 510 }, (_, index) => `line-${index}`);
                provider.appendLines(uri, lines);

                const content = provider.provideTextDocumentContent(uri);
                assert.ok(!content.includes("truncated"), "an unbounded document should never report truncation");
                assert.ok(content.includes("line-0"), "earliest line must be retained when unbounded");
                assert.ok(content.includes("line-509"), "most recent line must be retained");
            } finally {
                await config.update("logsViewer.maxLines", undefined, vscode.ConfigurationTarget.Global);
            }
        });

        it("renders a distinct header for a 'full' mode document", () => {
            const uri = buildFullLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(
                uri,
                { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123", mode: "full" },
                { unbounded: true }
            );

            const content = provider.provideTextDocumentContent(uri);
            assert.match(content, /Full Log/);
            assert.match(content, /Project:\s+demo/);
            assert.match(content, /Build ID:\s+demo:123/);
        });

        it("exposes the stored header via getHeader for an open document", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

            const header = provider.getHeader(uri);
            assert.deepEqual(header, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });
        });

        it("returns undefined from getHeader for a URI that was never opened", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "never-opened");
            assert.equal(provider.getHeader(uri), undefined);
        });

        it("appends a footer after the body content", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });
            provider.appendLines(uri, ["only line"]);
            provider.setFooter(uri, "-- End of log stream (build status: SUCCEEDED) --");

            const content = provider.provideTextDocumentContent(uri);
            const lineIndex = content.indexOf("only line");
            const footerIndex = content.indexOf("End of log stream");
            assert.ok(lineIndex >= 0 && footerIndex > lineIndex);
        });

        it("resets buffered content when the same build is opened again", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });
            provider.appendLines(uri, ["stale line from a previous session"]);

            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

            const content = provider.provideTextDocumentContent(uri);
            assert.ok(!content.includes("stale line from a previous session"));
        });

        it("invokes the registered canceller and clears state when the document closes", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "demo:123");
            provider.open(uri, { projectName: "demo", profile: "dev", region: "us-east-1", buildId: "demo:123" });

            let cancelled = false;
            provider.registerCanceller(uri, () => { cancelled = true; });

            provider.handleDocumentClosed(uri);

            assert.equal(cancelled, true);
            assert.match(provider.provideTextDocumentContent(uri), /log session has ended/);
        });

        it("returns a friendly message for a URI that was never opened", () => {
            const uri = buildLogsDocumentUri("dev", "us-east-1", "never-opened");
            assert.match(provider.provideTextDocumentContent(uri), /log session has ended/);
        });
    });
});
