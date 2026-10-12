import * as assert from "node:assert/strict";
import { createAppStore } from "../../state/store";
import {
    canSelectAllVisibleProjects,
    filterProjectsBySearch,
    formatBranchForNotification,
    formatDeploymentPreview,
    formatSanitizedScope,
    hasProjectInScope,
    resolveBuildFromArg,
    resolveProjectNameFromArg,
    sanitizeBuildId,
    setProjectStatus,
    shortenId,
    validateBranchInput,
    validateTemporaryCredentialExpiration
} from "../../commands/shared";

describe("commands/shared", () => {
    describe("validateBranchInput", () => {
        it("accepts an empty value (clears saved branch)", () => {
            assert.equal(validateBranchInput(""), undefined);
        });

        it("accepts a normal branch name", () => {
            assert.equal(validateBranchInput("feature/my-branch"), undefined);
        });

        it("rejects whitespace-only input", () => {
            assert.ok(validateBranchInput("   "));
        });

        it("rejects branches containing spaces", () => {
            assert.ok(validateBranchInput("feature branch"));
        });

        it("rejects branches starting with a dash", () => {
            assert.ok(validateBranchInput("-feature"));
        });

        it("rejects branches with unsafe git ref sequences", () => {
            assert.ok(validateBranchInput("feature..branch"));
            assert.ok(validateBranchInput("feature//branch"));
            assert.ok(validateBranchInput("feature@{branch}"));
            assert.ok(validateBranchInput("feature~1"));
            assert.ok(validateBranchInput("refs/heads/my.lock"));
        });

        it("rejects branches longer than 255 characters", () => {
            assert.ok(validateBranchInput("a".repeat(256)));
        });
    });

    describe("validateTemporaryCredentialExpiration", () => {
        it("requires a value", () => {
            assert.ok(validateTemporaryCredentialExpiration(""));
        });

        it("requires a parsable ISO 8601 timestamp", () => {
            assert.ok(validateTemporaryCredentialExpiration("not-a-date"));
        });

        it("requires the timestamp to be in the future", () => {
            assert.ok(validateTemporaryCredentialExpiration("2000-01-01T00:00:00Z"));
        });

        it("rejects expirations more than a year away", () => {
            const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
            assert.ok(validateTemporaryCredentialExpiration(farFuture));
        });

        it("accepts a valid near-future timestamp", () => {
            const nearFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            assert.equal(validateTemporaryCredentialExpiration(nearFuture), undefined);
        });
    });

    describe("formatBranchForNotification", () => {
        it("falls back to 'default source version' when empty", () => {
            assert.equal(formatBranchForNotification(undefined), "default source version");
            assert.equal(formatBranchForNotification("   "), "default source version");
        });

        it("returns the trimmed branch when present", () => {
            // The result is trimmed, even though empty/whitespace-only input is not accepted as a value.
            assert.equal(formatBranchForNotification(" main "), "main");
        });
    });

    describe("formatSanitizedScope / sanitizeBuildId", () => {
        it("redacts profile/region/buildId by default (verbose logging disabled)", () => {
            const scope = formatSanitizedScope("my-profile", "us-east-1");
            assert.match(scope, /<profile-redacted>\/<region-redacted>/);
            assert.equal(sanitizeBuildId("my-project:abcd-1234"), "<build-id-redacted>");
        });
    });

    describe("shortenId", () => {
        it("returns 'unknown' for empty input", () => {
            assert.equal(shortenId(""), "unknown");
        });

        it("returns short ids unchanged", () => {
            assert.equal(shortenId("abc123"), "abc123");
        });

        it("shortens long ids with an ellipsis", () => {
            const id = "my-project:0123456789abcdef";
            const shortened = shortenId(id);
            assert.ok(shortened.length < id.length);
            assert.ok(shortened.startsWith(id.slice(0, 8)));
            assert.ok(shortened.endsWith(id.slice(-5)));
        });
    });

    describe("resolveProjectNameFromArg", () => {
        it("resolves from a plain string", () => {
            assert.equal(resolveProjectNameFromArg("my-project"), "my-project");
        });

        it("resolves from a tree node shaped object", () => {
            assert.equal(resolveProjectNameFromArg({ project: { name: "my-project" } }), "my-project");
        });

        it("returns undefined for unrelated input", () => {
            assert.equal(resolveProjectNameFromArg(undefined), undefined);
            assert.equal(resolveProjectNameFromArg({}), undefined);
            assert.equal(resolveProjectNameFromArg(42), undefined);
        });
    });

    describe("resolveBuildFromArg", () => {
        const build = {
            id: "build-id",
            projectName: "my-project",
            profile: "my-profile",
            region: "us-east-1",
            status: "SUCCEEDED" as const
        };

        it("resolves a flat build-shaped object", () => {
            assert.deepEqual(resolveBuildFromArg(build), build);
        });

        it("resolves a tree node wrapping a build", () => {
            assert.deepEqual(resolveBuildFromArg({ kind: "historyBuild", build }), build);
        });

        it("returns undefined when required fields are missing", () => {
            assert.equal(resolveBuildFromArg({ id: "only-id" }), undefined);
            assert.equal(resolveBuildFromArg(null), undefined);
        });
    });

    describe("setProjectStatus", () => {
        it("updates only the matching project", () => {
            const projects = [{ name: "a" }, { name: "b", lastBuildStatus: "FAILED" }];
            const next = setProjectStatus(projects, "a", "SUCCEEDED");
            assert.equal(next[0].lastBuildStatus, "SUCCEEDED");
            assert.equal(next[1].lastBuildStatus, "FAILED");
            // Original array must not be mutated.
            assert.equal(projects[0].lastBuildStatus, undefined);
        });
    });

    describe("hasProjectInScope / filterProjectsBySearch", () => {
        const projects = [{ name: "web-app" }, { name: "worker" }, { name: "Web-Admin" }];

        it("hasProjectInScope checks exact name presence", () => {
            assert.equal(hasProjectInScope(projects, "worker"), true);
            assert.equal(hasProjectInScope(projects, "missing"), false);
        });

        it("filterProjectsBySearch is case-insensitive and sorts alphabetically", () => {
            const filtered = filterProjectsBySearch(projects, "web");
            assert.deepEqual(filtered.map((project) => project.name), ["web-app", "Web-Admin"].sort((a, b) => a.localeCompare(b)));
        });

        it("filterProjectsBySearch returns all projects (sorted) when filter is empty", () => {
            const filtered = filterProjectsBySearch(projects, "  ");
            assert.deepEqual(filtered.map((project) => project.name), ["web-app", "Web-Admin", "worker"].sort((a, b) => a.localeCompare(b)));
        });
    });

    describe("canSelectAllVisibleProjects", () => {
        it("is false with no visible projects", () => {
            const store = createAppStore();
            store.setProjects([]);
            assert.equal(canSelectAllVisibleProjects(store.getState()), false);
        });

        it("is true with no filter and at least one project", () => {
            const store = createAppStore();
            store.setProjects([{ name: "only-one" }]);
            assert.equal(canSelectAllVisibleProjects(store.getState()), true);
        });

        it("is false when a filter matches exactly one project", () => {
            const store = createAppStore();
            store.setProjects([{ name: "alpha" }, { name: "beta" }]);
            store.setProjectFilter("alpha");
            assert.equal(canSelectAllVisibleProjects(store.getState()), false);
        });

        it("is true when a filter matches more than one project", () => {
            const store = createAppStore();
            store.setProjects([{ name: "alpha-1" }, { name: "alpha-2" }, { name: "beta" }]);
            store.setProjectFilter("alpha");
            assert.equal(canSelectAllVisibleProjects(store.getState()), true);
        });
    });

    describe("formatDeploymentPreview", () => {
        it("renders project -> branch lines", () => {
            const preview = formatDeploymentPreview([
                { projectName: "a", branch: "main" },
                { projectName: "b" }
            ]);
            assert.equal(preview, "a -> main\nb -> default source version");
        });

        it("truncates after 20 lines with a remaining-count summary", () => {
            const batch = Array.from({ length: 25 }, (_, index) => ({ projectName: `p${index}` }));
            const preview = formatDeploymentPreview(batch);
            const lines = preview.split("\n");
            assert.equal(lines.length, 21);
            assert.equal(lines[20], "...and 5 more project(s)");
        });
    });
});
