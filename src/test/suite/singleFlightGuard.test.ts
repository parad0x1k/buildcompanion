import * as assert from "node:assert/strict";
import { releaseTriggerLock, tryAcquireTriggerLock } from "../../agent/singleFlightGuard";

describe("agent/singleFlightGuard", () => {
    it("allows the first acquire for a scope and blocks a concurrent second one", () => {
        assert.equal(tryAcquireTriggerLock("dev", "us-east-1", "demo"), true);
        assert.equal(tryAcquireTriggerLock("dev", "us-east-1", "demo"), false);
        releaseTriggerLock("dev", "us-east-1", "demo");
    });

    it("allows re-acquiring the same scope after it is released", () => {
        assert.equal(tryAcquireTriggerLock("dev", "us-east-1", "demo2"), true);
        releaseTriggerLock("dev", "us-east-1", "demo2");
        assert.equal(tryAcquireTriggerLock("dev", "us-east-1", "demo2"), true);
        releaseTriggerLock("dev", "us-east-1", "demo2");
    });

    it("treats different profile/region/project scopes independently", () => {
        assert.equal(tryAcquireTriggerLock("dev", "us-east-1", "demo3"), true);
        assert.equal(tryAcquireTriggerLock("dev", "us-east-1", "demo4"), true);
        assert.equal(tryAcquireTriggerLock("prod", "us-east-1", "demo3"), true);
        assert.equal(tryAcquireTriggerLock("dev", "eu-west-1", "demo3"), true);

        releaseTriggerLock("dev", "us-east-1", "demo3");
        releaseTriggerLock("dev", "us-east-1", "demo4");
        releaseTriggerLock("prod", "us-east-1", "demo3");
        releaseTriggerLock("dev", "eu-west-1", "demo3");
    });

    it("releasing an already-free scope is a harmless no-op", () => {
        releaseTriggerLock("dev", "us-east-1", "never-acquired");
        assert.equal(tryAcquireTriggerLock("dev", "us-east-1", "never-acquired"), true);
        releaseTriggerLock("dev", "us-east-1", "never-acquired");
    });
});
