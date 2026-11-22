import * as assert from "node:assert/strict";
import * as sinon from "sinon";
import type * as vscode from "vscode";
import {
    clearAwsClientCache,
    createCloudWatchLogsClient,
    createCodeBuildClient
} from "../../aws/clientFactory";

// The "environment" profile resolves to fromNodeProviderChain(), which is lazy: building a client
// never touches the network or any credentials file, so these tests need no AWS mocking.
const PROFILE = "environment";
const REGION = "us-east-1";
const TTL_MS = 5 * 60 * 1000;
const RETIRED_CLIENT_GRACE_MS = 60 * 1000;

function secretStorageWith(get: () => Promise<string | undefined>): vscode.SecretStorage {
    return { get } as unknown as vscode.SecretStorage;
}

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

    it("retires a client whose cache entry outlived its TTL only after in-flight requests had time to finish", async () => {
        clock = sinon.useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });

        const expired = await createCodeBuildClient(PROFILE, REGION);
        const destroySpy = sinon.spy(expired, "destroy");

        clock.tick(TTL_MS + 1);

        const replacement = await createCodeBuildClient(PROFILE, REGION);

        assert.notEqual(replacement, expired);
        // destroy() resets sockets that are mid-request (e.g. a log tail holding this client), so it
        // must not run at the moment of expiry.
        assert.equal(destroySpy.callCount, 0);

        clock.tick(RETIRED_CLIENT_GRACE_MS + 1);

        assert.equal(destroySpy.callCount, 1);
    });

    it("does not cache a client whose creation was overtaken by clearAwsClientCache()", async () => {
        clock = sinon.useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const storage = secretStorageWith(async () => {
            await gate;
            return undefined;
        });

        const pending = createCodeBuildClient("stale-profile", REGION, { secretStorage: storage });
        clearAwsClientCache();
        release();
        const stale = await pending;
        const staleDestroySpy = sinon.spy(stale, "destroy");

        const fresh = await createCodeBuildClient("stale-profile", REGION, { secretStorage: storage });
        const freshAgain = await createCodeBuildClient("stale-profile", REGION, { secretStorage: storage });

        assert.notEqual(fresh, stale, "the overtaken creation must not populate the cache");
        assert.equal(freshAgain, fresh, "the post-clear client is the one that gets cached");

        clock.tick(RETIRED_CLIENT_GRACE_MS + 1);
        assert.equal(staleDestroySpy.callCount, 1, "the uncached client must still be closed eventually");
    });

    it("shares a failed creation with concurrent callers, caches nothing, and retries on the next call", async () => {
        let calls = 0;
        const storage = secretStorageWith(async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error("secret storage unavailable");
            }
            return undefined;
        });

        const results = await Promise.allSettled([
            createCodeBuildClient("flaky-profile", REGION, { secretStorage: storage }),
            createCodeBuildClient("flaky-profile", REGION, { secretStorage: storage })
        ]);

        assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
        assert.equal(calls, 1, "concurrent callers share one credential resolution");

        const recovered = await createCodeBuildClient("flaky-profile", REGION, { secretStorage: storage });

        assert.ok(recovered);
        assert.equal(calls, 2, "a failure must not be cached or left in flight");
    });

    it("rejects a missing profile or region", async () => {
        await assert.rejects(() => createCodeBuildClient("  ", REGION), /profile is required/);
        await assert.rejects(() => createCodeBuildClient(PROFILE, "  "), /region is required/);
        await assert.rejects(() => createCloudWatchLogsClient("", REGION), /profile is required/);
    });
});
