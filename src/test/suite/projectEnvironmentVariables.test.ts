import * as assert from "node:assert/strict";
import { ENV_VAR_TYPES, formatEnvVarPickDetails, validateVariableName } from "../../commands/projectEnvironmentVariables";

describe("commands/projectEnvironmentVariables", () => {
    describe("formatEnvVarPickDetails", () => {
        it("shows a plain text variable's value under a friendly type name", () => {
            assert.deepEqual(
                formatEnvVarPickDetails({ name: "NODE_ENV", value: "production", type: "PLAINTEXT" }),
                { description: "Plain text", detail: "production" }
            );
        });

        it("marks an empty plain text value instead of rendering a blank line", () => {
            assert.equal(formatEnvVarPickDetails({ name: "EMPTY", value: "", type: "PLAINTEXT" }).detail, "(empty)");
        });

        it("shows the parameter a Parameter Store variable resolves from, with an icon instead of an arrow", () => {
            assert.deepEqual(
                formatEnvVarPickDetails({ name: "DB_HOST", value: "/app/prod/db-host", type: "PARAMETER_STORE" }),
                { description: "Parameter Store", detail: "$(link) /app/prod/db-host" }
            );
        });

        it("shows the secret a Secrets Manager variable resolves from, with a lock icon", () => {
            assert.deepEqual(
                formatEnvVarPickDetails({ name: "API_KEY", value: "prod/api:key", type: "SECRETS_MANAGER" }),
                { description: "Secrets Manager", detail: "$(lock) prod/api:key" }
            );
        });

        it("never renders an ASCII arrow", () => {
            for (const type of ["PLAINTEXT", "PARAMETER_STORE", "SECRETS_MANAGER"] as const) {
                const { detail } = formatEnvVarPickDetails({ name: "X", value: "v", type });
                assert.ok(!detail.includes("->") && !detail.includes("→"), `${type}: ${detail}`);
            }
        });
    });

    describe("ENV_VAR_TYPES", () => {
        it("labels every type with a readable name rather than the raw AWS enum", () => {
            assert.deepEqual(
                ENV_VAR_TYPES.map((item) => item.label),
                ["$(symbol-string) Plain text", "$(link) Parameter Store", "$(lock) Secrets Manager"]
            );
            assert.deepEqual(ENV_VAR_TYPES.map((item) => item.type), ["PLAINTEXT", "PARAMETER_STORE", "SECRETS_MANAGER"]);
        });
    });

    describe("validateVariableName", () => {
        it("accepts a valid unique name and rejects duplicates and bad characters", () => {
            const existing = [{ name: "TAKEN", value: "1", type: "PLAINTEXT" as const }];
            assert.equal(validateVariableName("NEW_VAR", existing), undefined);
            assert.match(validateVariableName("TAKEN", existing) ?? "", /already exists/);
            assert.match(validateVariableName("1BAD", existing) ?? "", /cannot start with a number/);
            assert.match(validateVariableName("   ", existing) ?? "", /required/);
        });
    });
});
