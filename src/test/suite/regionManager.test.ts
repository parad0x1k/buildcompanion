import * as assert from "node:assert/strict";
import {
    getPersistedRegion,
    getSupportedRegions,
    persistRegion,
    resolveDefaultRegion
} from "../../aws/regionManager";
import { createFakeExtensionContext } from "../testHelpers";

describe("aws/regionManager", () => {
    it("returns a non-empty, deduplicated list of supported regions including us-east-1", () => {
        const regions = getSupportedRegions();
        assert.ok(regions.length > 10);
        assert.ok(regions.includes("us-east-1"));
        assert.equal(new Set(regions).size, regions.length);
    });

    describe("resolveDefaultRegion", () => {
        it("prefers the persisted region above all else", () => {
            const region = resolveDefaultRegion({
                persistedRegion: "eu-west-1",
                profileRegion: "ap-south-1",
                environmentRegion: "us-west-2"
            });
            assert.equal(region, "eu-west-1");
        });

        it("falls back to the profile region when nothing is persisted", () => {
            const region = resolveDefaultRegion({
                profileRegion: "ap-south-1",
                environmentRegion: "us-west-2"
            });
            assert.equal(region, "ap-south-1");
        });

        it("falls back to the environment region when no persisted/profile region exists", () => {
            const region = resolveDefaultRegion({ environmentRegion: "us-west-2" });
            assert.equal(region, "us-west-2");
        });

        it("falls back to us-east-1 when nothing else is available", () => {
            assert.equal(resolveDefaultRegion({}), "us-east-1");
        });

        it("ignores blank/whitespace-only region values", () => {
            const region = resolveDefaultRegion({
                persistedRegion: "   ",
                profileRegion: "ap-south-1"
            });
            assert.equal(region, "ap-south-1");
        });
    });

    describe("persisted region (global state)", () => {
        it("round-trips through a fake ExtensionContext's globalState", async () => {
            const context = createFakeExtensionContext();
            assert.equal(getPersistedRegion(context), undefined);

            await persistRegion(context, "sa-east-1");
            assert.equal(getPersistedRegion(context), "sa-east-1");
        });
    });
});
