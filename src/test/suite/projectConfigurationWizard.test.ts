import * as assert from "node:assert/strict";
import type { ComputeType, EnvironmentType } from "@aws-sdk/client-codebuild";
import type { ProjectEnvironmentVariable } from "../../aws/codebuildService";
import {
    buildConfigurationChanges,
    buildConfigurationDiffLines,
    buildOverridesFromDraft,
    describeComputeType,
    describeEnvironmentType,
    getComputeTypeChoices,
    type ConfigurationDraft
} from "../../commands/projectConfigurationWizard";

function makeDraft(overrides: Partial<ConfigurationDraft> = {}): ConfigurationDraft {
    const environmentVariables: ProjectEnvironmentVariable[] = [{ name: "FOO", value: "bar", type: "PLAINTEXT" }];

    return {
        environmentType: "LINUX_CONTAINER",
        image: "aws/codebuild/standard:7.0",
        computeType: "BUILD_GENERAL1_SMALL",
        privilegedMode: false,
        imagePullCredentialsType: "CODEBUILD",
        environmentVariables,
        buildspec: "",
        timeoutInMinutes: 60,
        queuedTimeoutInMinutes: 480,
        ...overrides
    };
}

describe("commands/projectConfigurationWizard", () => {
    describe("getComputeTypeChoices", () => {
        it("returns the standard compute sizes for a non-Lambda environment type", () => {
            const choices = getComputeTypeChoices("LINUX_CONTAINER", "BUILD_GENERAL1_SMALL");
            assert.deepEqual(choices, [
                "BUILD_GENERAL1_SMALL",
                "BUILD_GENERAL1_MEDIUM",
                "BUILD_GENERAL1_LARGE",
                "BUILD_GENERAL1_XLARGE",
                "BUILD_GENERAL1_2XLARGE"
            ]);
        });

        it("returns the Lambda compute sizes for a Lambda environment type", () => {
            const choices = getComputeTypeChoices("LINUX_LAMBDA_CONTAINER", "BUILD_LAMBDA_1GB");
            assert.deepEqual(choices, ["BUILD_LAMBDA_1GB", "BUILD_LAMBDA_2GB", "BUILD_LAMBDA_4GB", "BUILD_LAMBDA_8GB", "BUILD_LAMBDA_10GB"]);
        });

        it("appends an advanced current value instead of hiding it", () => {
            const choices = getComputeTypeChoices("LINUX_CONTAINER", "ATTRIBUTE_BASED_COMPUTE" as ComputeType);
            assert.ok(choices.includes("ATTRIBUTE_BASED_COMPUTE"));
            assert.equal(choices[choices.length - 1], "ATTRIBUTE_BASED_COMPUTE");
        });

        it("does not duplicate the current value when it's already in the curated list", () => {
            const choices = getComputeTypeChoices("LINUX_CONTAINER", "BUILD_GENERAL1_LARGE");
            assert.equal(choices.filter((choice) => choice === "BUILD_GENERAL1_LARGE").length, 1);
        });
    });

    describe("describeEnvironmentType / describeComputeType", () => {
        it("returns a friendly label for known values", () => {
            assert.equal(describeEnvironmentType("ARM_CONTAINER"), "Linux (ARM/Graviton)");
            assert.equal(describeComputeType("BUILD_GENERAL1_SMALL"), "Small");
        });

        it("falls back to the raw value for unrecognized values", () => {
            assert.equal(describeEnvironmentType("SOME_FUTURE_TYPE" as EnvironmentType), "SOME_FUTURE_TYPE");
            assert.equal(describeComputeType("SOME_FUTURE_SIZE" as ComputeType), "SOME_FUTURE_SIZE");
        });
    });

    describe("buildConfigurationDiffLines", () => {
        it("returns no lines when nothing changed", () => {
            const baseline = makeDraft();
            const lines = buildConfigurationDiffLines({ baseline, draft: makeDraft(), includeBranch: false });
            assert.deepEqual(lines, []);
        });

        it("describes a scalar field change with a before/after arrow", () => {
            const baseline = makeDraft();
            const draft = makeDraft({ image: "aws/codebuild/standard:6.0" });
            const lines = buildConfigurationDiffLines({ baseline, draft, includeBranch: false });
            assert.deepEqual(lines, ["Image: aws/codebuild/standard:7.0 \u2192 aws/codebuild/standard:6.0"]);
        });

        it("summarizes added/changed/removed environment variables", () => {
            const baseline = makeDraft({
                environmentVariables: [
                    { name: "KEEP_SAME", value: "1", type: "PLAINTEXT" },
                    { name: "WILL_CHANGE", value: "old", type: "PLAINTEXT" },
                    { name: "WILL_REMOVE", value: "gone", type: "PLAINTEXT" }
                ]
            });
            const draft = makeDraft({
                environmentVariables: [
                    { name: "KEEP_SAME", value: "1", type: "PLAINTEXT" },
                    { name: "WILL_CHANGE", value: "new", type: "PLAINTEXT" },
                    { name: "NEW_VAR", value: "added", type: "PLAINTEXT" }
                ]
            });

            const lines = buildConfigurationDiffLines({ baseline, draft, includeBranch: false });
            assert.deepEqual(lines, ["Environment variables: 1 added, 1 changed, 1 removed"]);
        });

        it("only includes a branch line when includeBranch is true and the branch differs", () => {
            const baseline = makeDraft();

            const withBranch = buildConfigurationDiffLines({
                baseline,
                draft: makeDraft(),
                includeBranch: true,
                baselineBranch: undefined,
                draftBranch: "feature/x"
            });
            assert.deepEqual(withBranch, ["Branch / source version: project default \u2192 feature/x"]);

            const withoutBranchTracking = buildConfigurationDiffLines({
                baseline,
                draft: makeDraft(),
                includeBranch: false
            });
            assert.deepEqual(withoutBranchTracking, []);
        });
    });

    describe("buildOverridesFromDraft", () => {
        it("returns an empty object when nothing changed and no branch is set", () => {
            const overrides = buildOverridesFromDraft(makeDraft(), makeDraft(), undefined);
            assert.deepEqual(overrides, {});
        });

        it("includes sourceVersion only when a branch is provided", () => {
            const overrides = buildOverridesFromDraft(makeDraft(), makeDraft(), "main");
            assert.deepEqual(overrides, { sourceVersion: "main" });
        });

        it("includes only the fields that changed, leaving the rest undefined", () => {
            const baseline = makeDraft();
            const draft = makeDraft({ computeType: "BUILD_GENERAL1_LARGE", privilegedMode: true });

            const overrides = buildOverridesFromDraft(baseline, draft, undefined);

            assert.equal(overrides.computeTypeOverride, "BUILD_GENERAL1_LARGE");
            assert.equal(overrides.privilegedModeOverride, true);
            assert.equal(overrides.imageOverride, undefined);
            assert.equal(overrides.environmentTypeOverride, undefined);
            assert.equal(overrides.buildspecOverride, undefined);
        });

        it("sends the full environment variable list when any variable changed", () => {
            const baseline = makeDraft();
            const draft = makeDraft({ environmentVariables: [{ name: "FOO", value: "updated", type: "PLAINTEXT" }] });

            const overrides = buildOverridesFromDraft(baseline, draft, undefined);
            assert.deepEqual(overrides.environmentVariablesOverride, [{ name: "FOO", value: "updated", type: "PLAINTEXT" }]);
        });
    });

    describe("buildConfigurationChanges", () => {
        it("returns an empty object when nothing changed", () => {
            const changes = buildConfigurationChanges(makeDraft(), makeDraft());
            assert.deepEqual(changes, {});
        });

        it("includes only the fields that changed", () => {
            const baseline = makeDraft();
            const draft = makeDraft({ timeoutInMinutes: 120, buildspec: "buildspec-release.yml" });

            const changes = buildConfigurationChanges(baseline, draft);

            assert.equal(changes.timeoutInMinutes, 120);
            assert.equal(changes.buildspec, "buildspec-release.yml");
            assert.equal(changes.queuedTimeoutInMinutes, undefined);
            assert.equal(changes.image, undefined);
            assert.equal(changes.environmentVariables, undefined);
        });
    });
});
