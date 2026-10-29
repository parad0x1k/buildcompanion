import * as assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listAwsProfiles, parseIni } from "../../aws/profileManager";

const ENV_KEYS = [
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "AWS_DEFAULT_REGION"
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Partial<Record<EnvKey, string>>;

function snapshotEnv(): EnvSnapshot {
    const snapshot: EnvSnapshot = {};
    for (const key of ENV_KEYS) {
        if (process.env[key] !== undefined) {
            snapshot[key] = process.env[key];
        }
    }
    return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
    for (const key of ENV_KEYS) {
        if (snapshot[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = snapshot[key];
        }
    }
}

async function makeTempDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "buildcompanion-profile-test-"));
}

describe("aws/profileManager", () => {
    // parseIni: fast, precise unit tests against the pure parsing function directly.
    describe("parseIni", () => {
        it("parses section headers and key/value pairs", () => {
            const sections = parseIni(["[default]", "region = us-east-1", "output = json"].join("\n"));
            assert.deepEqual(sections, { default: { region: "us-east-1", output: "json" } });
        });

        it("parses a 'profile NAME' config section", () => {
            const sections = parseIni(["[profile staging]", "region = eu-west-1"].join("\n"));
            assert.deepEqual(sections, { "profile staging": { region: "eu-west-1" } });
        });

        it("ignores blank lines and #/; comment lines", () => {
            const sections = parseIni([
                "# a comment",
                "",
                "; also a comment",
                "[default]",
                "   ",
                "region = us-east-1"
            ].join("\n"));
            assert.deepEqual(sections, { default: { region: "us-east-1" } });
        });

        it("ignores key/value lines that appear before any section header", () => {
            const sections = parseIni(["region = us-east-1", "[default]", "output = json"].join("\n"));
            assert.deepEqual(sections, { default: { output: "json" } });
        });

        it("ignores lines with no '=' separator", () => {
            const sections = parseIni(["[default]", "not-a-key-value-line", "region = us-east-1"].join("\n"));
            assert.deepEqual(sections, { default: { region: "us-east-1" } });
        });

        it("strips matching double quotes from a value", () => {
            const sections = parseIni(["[default]", 'region = "us-west-2"'].join("\n"));
            assert.equal(sections.default.region, "us-west-2");
        });

        it("strips matching single quotes from a value", () => {
            const sections = parseIni(["[default]", "region = 'us-west-2'"].join("\n"));
            assert.equal(sections.default.region, "us-west-2");
        });

        it("does not strip mismatched or partial quotes", () => {
            const sections = parseIni(["[default]", "output = \"json"].join("\n"));
            assert.equal(sections.default.output, "\"json");
        });

        it("joins an indented continuation line onto the previous key's value", () => {
            const sections = parseIni([
                "[profile wrapped]",
                "role_arn = arn:aws:iam::123456789012:role/Example",
                "    -continued-suffix"
            ].join("\n"));
            assert.equal(sections["profile wrapped"].role_arn, "arn:aws:iam::123456789012:role/Example -continued-suffix");
        });

        it("supports tab-indented continuation lines", () => {
            const sections = parseIni([
                "[profile wrapped]",
                "role_arn = arn:aws:iam::123456789012:role/Example",
                "\t-continued-suffix"
            ].join("\n"));
            assert.equal(sections["profile wrapped"].role_arn, "arn:aws:iam::123456789012:role/Example -continued-suffix");
        });

        it("does not treat an indented line before any key as a continuation", () => {
            const sections = parseIni(["[default]", "    region = us-east-1"].join("\n"));
            // No prior key in this section, so this indented line is parsed as a normal
            // key/value pair rather than silently dropped or mis-joined.
            assert.equal(sections.default.region, "us-east-1");
        });

        it("resets the continuation target when a new section starts", () => {
            const sections = parseIni([
                "[profile a]",
                "region = us-east-1",
                "[profile b]",
                "    not-a-continuation = should-not-attach-to-profile-a"
            ].join("\n"));
            assert.equal(sections["profile a"].region, "us-east-1");
            assert.equal(sections["profile b"]["not-a-continuation"], "should-not-attach-to-profile-a");
        });
    });

    // listAwsProfiles: end-to-end behavior against real temporary config/credentials files,
    // exercised through the documented AWS_CONFIG_FILE/AWS_SHARED_CREDENTIALS_FILE overrides.
    describe("listAwsProfiles", () => {
        let originalEnv: EnvSnapshot;
        let tempDir: string;

        beforeEach(async () => {
            originalEnv = snapshotEnv();
            for (const key of ENV_KEYS) {
                delete process.env[key];
            }
            tempDir = await makeTempDir();
            process.env.AWS_CONFIG_FILE = path.join(tempDir, "config");
            process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(tempDir, "credentials");
        });

        afterEach(async () => {
            restoreEnv(originalEnv);
            await fs.rm(tempDir, { recursive: true, force: true });
        });

        async function writeConfig(content: string): Promise<void> {
            await fs.writeFile(process.env.AWS_CONFIG_FILE as string, content);
        }

        async function writeCredentials(content: string): Promise<void> {
            await fs.writeFile(process.env.AWS_SHARED_CREDENTIALS_FILE as string, content);
        }

        it("returns an empty list when neither file exists", async () => {
            const profiles = await listAwsProfiles();
            assert.deepEqual(profiles, []);
        });

        it("parses the default profile and named profiles from the config file", async () => {
            await writeConfig([
                "[default]",
                "region = us-east-1",
                "",
                "[profile staging]",
                "region = eu-west-1"
            ].join("\n"));

            const profiles = await listAwsProfiles();

            assert.deepEqual(
                profiles.map((profile) => ({ name: profile.name, type: profile.type, region: profile.region })),
                [
                    { name: "default", type: "local", region: "us-east-1" },
                    { name: "staging", type: "local", region: "eu-west-1" }
                ]
            );
        });

        it("merges a profile that appears in both the config and credentials files", async () => {
            await writeConfig(["[profile staging]", "region = eu-west-1"].join("\n"));
            await writeCredentials(["[staging]", "aws_access_key_id = AKIATEST", "aws_secret_access_key = secret"].join("\n"));

            const profiles = await listAwsProfiles();

            assert.deepEqual(profiles.map((profile) => profile.name), ["staging"]);
            assert.equal(profiles[0].region, "eu-west-1");
        });

        it("reads a bare-named profile from the credentials file alone", async () => {
            await writeCredentials(["[only-in-credentials]", "aws_access_key_id = AKIATEST"].join("\n"));

            const profiles = await listAwsProfiles();

            assert.deepEqual(profiles.map((profile) => profile.name), ["only-in-credentials"]);
        });

        it("detects an SSO profile via sso_start_url", async () => {
            await writeConfig([
                "[profile sso-user]",
                "sso_start_url = https://example.awsapps.com/start",
                "region = us-west-2"
            ].join("\n"));

            const profiles = await listAwsProfiles();
            assert.equal(profiles[0].type, "sso");
        });

        it("detects an SSO profile via sso_session", async () => {
            await writeConfig(["[profile sso-user]", "sso_session = my-session", "region = us-west-2"].join("\n"));

            const profiles = await listAwsProfiles();
            assert.equal(profiles[0].type, "sso");
        });

        it("resolves region from AWS_REGION, then AWS_DEFAULT_REGION, then defaults to us-east-1", async () => {
            await writeConfig(["[profile no-region]"].join("\n"));

            const withNoEnvRegion = await listAwsProfiles();
            assert.equal(withNoEnvRegion[0].region, "us-east-1");

            process.env.AWS_DEFAULT_REGION = "ap-southeast-2";
            const withDefaultRegion = await listAwsProfiles();
            assert.equal(withDefaultRegion[0].region, "ap-southeast-2");

            process.env.AWS_REGION = "eu-central-1";
            const withRegion = await listAwsProfiles();
            assert.equal(withRegion[0].region, "eu-central-1");
        });

        it("synthesizes an 'environment' profile when environment credentials are present", async () => {
            process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
            process.env.AWS_SECRET_ACCESS_KEY = "secret";

            const profiles = await listAwsProfiles();

            assert.ok(profiles.some((profile) => profile.name === "environment" && profile.type === "environment"));
        });

        it("does not duplicate an 'environment' profile that already exists by that name", async () => {
            await writeConfig(["[profile environment]", "region = us-east-1"].join("\n"));
            process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
            process.env.AWS_SECRET_ACCESS_KEY = "secret";

            const profiles = await listAwsProfiles();

            assert.equal(profiles.filter((profile) => profile.name === "environment").length, 1);
        });

        it("sorts profiles alphabetically", async () => {
            await writeConfig(["[profile zeta]", "[profile alpha]", "[profile mid]"].join("\n"));

            const profiles = await listAwsProfiles();

            assert.deepEqual(profiles.map((profile) => profile.name), ["alpha", "mid", "zeta"]);
        });

        it("resolves a quoted region value", async () => {
            await writeConfig(["[profile quoted]", 'region = "us-west-2"'].join("\n"));

            const profiles = await listAwsProfiles();
            assert.equal(profiles[0].region, "us-west-2");
        });
    });
});
