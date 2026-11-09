import * as assert from "node:assert/strict";
import * as sinon from "sinon";
import {
    clearAwsClientCache,
    createCloudWatchLogsClient,
    createCodeBuildClient
} from "../../aws/clientFactory";

// The "environment" profile resolves to fromNodeProviderChain(), which is lazy: building a client
// never touches the network or any credentials file, so these tests need no AWS mocking.
const PROFILE = "environment";
const REGION = "us-east-1";

describe("aws/clientFactory", () => {
    let clock: sinon.SinonFakeTimers | undefined;

    beforeEach(() => {
        clearAwsClientCache();
    });

    afterEach(() => {
        clock?.restore();
        clock = undefined;
        clearAwsClientCache();
    });

    it("reuses one client for repeated sequential calls", async () => {
        const first = await createCodeBuildClient(PROFILE, REGION);
        const second = await createCodeBuildClient(PROFILE, REGION);

        assert.equal(first, second);
    });

    it("collapses concurrent cache misses into a single client", async () => {
        const [a, b, c] = await Promise.all([
            createCodeBuildClient(PROFILE, REGION),
            createCodeBuildClient(PROFILE, REGION),
            createCodeBuildClient(PROFILE, REGION)
        ]);

        assert.equal(a, b);
        assert.equal(b, c);
    });

    it("collapses concurrent CloudWatch Logs cache misses into a single client", async () => {
        const [a, b] = await Promise.all([
            createCloudWatchLogsClient(PROFILE, REGION),
            createCloudWatchLogsClient(PROFILE, REGION)
        ]);

        assert.equal(a, b);
    });

    it("does not share a client across different regions", async () => {
        const [east, west] = await Promise.all([
            createCodeBuildClient(PROFILE, "us-east-1"),
            createCodeBuildClient(PROFILE, "us-west-2")
        ]);

        assert.notEqual(east, west);
    });

    it("destroys a client whose cache entry has outlived its TTL", async () => {
        clock = sinon.useFakeTimers({ now: Date.now(), toFake: ["Date"] });

        const expired = await createCodeBuildClient(PROFILE, REGION);
        const destroySpy = sinon.spy(expired, "destroy");

        clock.tick(5 * 60 * 1000 + 1);

        const replacement = await createCodeBuildClient(PROFILE, REGION);

        assert.notEqual(replacement, expired);
        assert.equal(destroySpy.callCount, 1);
    });

    it("rejects a missing profile or region without caching anything", async () => {
        await assert.rejects(() => createCodeBuildClient("  ", REGION), /profile is required/);
        await assert.rejects(() => createCodeBuildClient(PROFILE, "  "), /region is required/);
        await assert.rejects(() => createCloudWatchLogsClient("", REGION), /profile is required/);
    });
});
