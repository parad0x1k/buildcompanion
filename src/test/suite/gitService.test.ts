import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { getRecentGitBranchSuggestions } from "../../git/gitService";

const execFileAsync = promisify(execFile);

async function makeTempDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "buildcompanion-git-test-"));
}

describe("git/gitService", () => {
    describe("getRecentGitBranchSuggestions", () => {
        it("returns no suggestions for a directory that is not a git repository", async () => {
            const tempDir = await makeTempDir();
            try {
                const suggestions = await getRecentGitBranchSuggestions(tempDir);
                assert.deepEqual(suggestions.branches, []);
                assert.equal(suggestions.currentBranch, undefined);
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true });
            }
        });

        it("parses real git output, marking the checked-out branch as current", async function () {
            this.timeout(20000);

            const tempDir = await makeTempDir();
            try {
                await execFileAsync("git", ["init"], { cwd: tempDir });
                await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
                await execFileAsync("git", ["config", "user.name", "BuildCompanion Test"], { cwd: tempDir });
                await execFileAsync("git", ["checkout", "-b", "main"], { cwd: tempDir });
                await fs.writeFile(path.join(tempDir, "readme.txt"), "hello");
                await execFileAsync("git", ["add", "-A"], { cwd: tempDir });
                await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: tempDir });
                await execFileAsync("git", ["checkout", "-b", "feature/my-change"], { cwd: tempDir });
                await execFileAsync("git", ["checkout", "main"], { cwd: tempDir });

                const suggestions = await getRecentGitBranchSuggestions(tempDir);

                assert.equal(suggestions.currentBranch, "main");
                assert.ok(suggestions.branches.includes("main"));
                assert.ok(suggestions.branches.includes("feature/my-change"));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    // git is not installed on this machine; the fallback-path tests above still
                    // cover the extension's graceful-degradation behavior.
                    this.skip();
                    return;
                }
                throw error;
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true });
            }
        });

        it("limits suggestions to the requested count", async function () {
            this.timeout(20000);

            const tempDir = await makeTempDir();
            try {
                await execFileAsync("git", ["init"], { cwd: tempDir });
                await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
                await execFileAsync("git", ["config", "user.name", "BuildCompanion Test"], { cwd: tempDir });
                await execFileAsync("git", ["checkout", "-b", "main"], { cwd: tempDir });
                await fs.writeFile(path.join(tempDir, "readme.txt"), "hello");
                await execFileAsync("git", ["add", "-A"], { cwd: tempDir });
                await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: tempDir });

                for (let i = 0; i < 4; i += 1) {
                    await execFileAsync("git", ["checkout", "-b", `branch-${i}`], { cwd: tempDir });
                }

                const suggestions = await getRecentGitBranchSuggestions(tempDir, 2);
                assert.equal(suggestions.branches.length, 2);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    this.skip();
                    return;
                }
                throw error;
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true });
            }
        });
    });
});
