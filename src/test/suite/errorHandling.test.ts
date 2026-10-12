import * as assert from "node:assert/strict";
import { getNoProfilesMessage, getUserFriendlyErrorMessage } from "../../aws/errorHandling";

describe("aws/errorHandling", () => {
    it("returns the standard no-profiles guidance message", () => {
        assert.equal(getNoProfilesMessage(), "No AWS profiles found. Run 'aws configure' or 'aws sso login'");
    });

    it("maps SSO-expired errors by error name", () => {
        const error = Object.assign(new Error("token expired"), { name: "UnauthorizedSSOTokenError" });
        const message = getUserFriendlyErrorMessage(error, { profile: "dev" });
        assert.match(message, /SSO session expired for profile dev/);
        assert.match(message, /aws sso login/);
    });

    it("maps SSO-expired errors by message text", () => {
        const error = new Error("Your session has expired, run aws sso login to refresh");
        const message = getUserFriendlyErrorMessage(error, { profile: "dev" });
        assert.match(message, /SSO session expired for profile dev/);
    });

    it("maps invalid-credential errors", () => {
        const error = Object.assign(new Error("bad creds"), { name: "InvalidClientTokenId" });
        const message = getUserFriendlyErrorMessage(error, { profile: "dev" });
        assert.equal(message, "Invalid AWS credentials for profile dev");
    });

    it("maps permission-denied errors with operation context", () => {
        const error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        const message = getUserFriendlyErrorMessage(error, { profile: "dev", operation: "Retrying build" });
        assert.equal(message, "Retrying build failed due to missing AWS permissions for profile dev");
    });

    it("maps permission-denied errors without operation context", () => {
        const error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        const message = getUserFriendlyErrorMessage(error, { profile: "dev" });
        assert.equal(message, "Missing required AWS permissions for profile dev");
    });

    it("appends required IAM permissions for permission-denied errors when provided", () => {
        const error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        const message = getUserFriendlyErrorMessage(error, {
            profile: "dev",
            operation: "Retrying build",
            requiredPermissions: ["codebuild:RetryBuild"]
        });

        assert.equal(
            message,
            "Retrying build failed due to missing AWS permissions for profile dev. Required IAM permission(s): codebuild:RetryBuild"
        );
    });

    it("joins multiple required permissions", () => {
        const error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        const message = getUserFriendlyErrorMessage(error, {
            profile: "dev",
            operation: "Updating project environment variables",
            requiredPermissions: ["codebuild:BatchGetProjects", "codebuild:UpdateProject"]
        });

        assert.match(message, /Required IAM permission\(s\): codebuild:BatchGetProjects, codebuild:UpdateProject$/);
    });

    it("remains classified as permission-denied when an already-friendly message is re-wrapped", () => {
        // Simulates the service layer -> command layer double-wrap: the service throws a
        // plain Error whose message is already the friendly, permission-denied text (no
        // recognizable AWS error `name` survives the re-wrap), and the command layer calls
        // getUserFriendlyErrorMessage again on that Error.
        const firstPass = getUserFriendlyErrorMessage(
            Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
            { profile: "dev", operation: "Retrying build", requiredPermissions: ["codebuild:RetryBuild"] }
        );

        const rewrapped = new Error(`${firstPass} (profile: dev, region: us-east-1)`);
        const secondPass = getUserFriendlyErrorMessage(rewrapped, {
            profile: "dev",
            operation: "Retrying build",
            requiredPermissions: ["codebuild:RetryBuild"]
        });

        assert.match(secondPass, /missing AWS permissions for profile dev/);
        assert.match(secondPass, /codebuild:RetryBuild/);
    });

    it("maps invalid-region errors", () => {
        const error = Object.assign(new Error("could not resolve endpoint"), { name: "UnknownEndpoint" });
        assert.equal(getUserFriendlyErrorMessage(error), "Invalid AWS region selected");
    });

    it("falls back to a generic message with operation context", () => {
        const error = new Error("something unexpected happened");
        const message = getUserFriendlyErrorMessage(error, { operation: "Listing projects" });
        assert.equal(message, "Listing projects failed. Please check AWS configuration and try again.");
    });

    it("falls back to a generic message without operation context", () => {
        const message = getUserFriendlyErrorMessage(new Error("boom"));
        assert.equal(message, "AWS operation failed. Please check AWS configuration and try again.");
    });

    it("defaults the profile placeholder when none is provided", () => {
        const error = Object.assign(new Error("bad creds"), { name: "InvalidClientTokenId" });
        const message = getUserFriendlyErrorMessage(error);
        assert.equal(message, "Invalid AWS credentials for profile selected profile");
    });
});
