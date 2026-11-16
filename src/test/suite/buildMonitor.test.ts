import * as assert from "node:assert/strict";
import { resolveMonitorPollIntervalMs } from "../../monitor/buildMonitor";

describe("monitor/buildMonitor", () => {
    describe("resolveMonitorPollIntervalMs", () => {
        const base = { baseIntervalMs: 5000, adaptivePolling: true, windowFocused: true };

        it("uses the base interval for a few builds while focused", () => {
            assert.equal(resolveMonitorPollIntervalMs({ ...base, activeBuildCount: 1 }), 5000);
            assert.equal(resolveMonitorPollIntervalMs({ ...base, activeBuildCount: 2 }), 5000);
        });

        it("stretches the interval as more builds run concurrently, up to the 15s cap", () => {
            assert.equal(resolveMonitorPollIntervalMs({ ...base, activeBuildCount: 5 }), 6000);
            assert.equal(resolveMonitorPollIntervalMs({ ...base, activeBuildCount: 12 }), 8000);
            assert.equal(resolveMonitorPollIntervalMs({ ...base, activeBuildCount: 30 }), 15000);
        });

        it("ignores the build count when adaptive polling is off", () => {
            assert.equal(resolveMonitorPollIntervalMs({ ...base, adaptivePolling: false, activeBuildCount: 30 }), 5000);
        });

        it("slows down 3x while no VS Code window is focused, capped at 30s", () => {
            assert.equal(resolveMonitorPollIntervalMs({ ...base, windowFocused: false, activeBuildCount: 1 }), 15000);
            assert.equal(resolveMonitorPollIntervalMs({ ...base, windowFocused: false, activeBuildCount: 30 }), 30000);
        });

        it("never polls faster when unfocused than when focused", () => {
            for (const activeBuildCount of [0, 1, 3, 9, 25]) {
                for (const baseIntervalMs of [3000, 5000, 15000]) {
                    const focused = resolveMonitorPollIntervalMs({ ...base, baseIntervalMs, activeBuildCount });
                    const unfocused = resolveMonitorPollIntervalMs({ ...base, baseIntervalMs, activeBuildCount, windowFocused: false });
                    assert.ok(unfocused >= focused, `unfocused ${unfocused}ms < focused ${focused}ms`);
                }
            }
        });
    });
});
