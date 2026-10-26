import * as assert from "node:assert/strict";
import {
    getPersistedBuildTimeDisplayFormat,
    persistBuildTimeDisplayFormat
} from "../../state/timeDisplayPreference";
import { createFakeExtensionContext } from "../testHelpers";

describe("state/timeDisplayPreference", () => {
    it("defaults to 'local' when nothing is persisted", () => {
        const context = createFakeExtensionContext();
        assert.equal(getPersistedBuildTimeDisplayFormat(context), "local");
    });

    it("round-trips 'utc' through a fake ExtensionContext's globalState", async () => {
        const context = createFakeExtensionContext();

        await persistBuildTimeDisplayFormat(context, "utc");
        assert.equal(getPersistedBuildTimeDisplayFormat(context), "utc");

        await persistBuildTimeDisplayFormat(context, "local");
        assert.equal(getPersistedBuildTimeDisplayFormat(context), "local");
    });
});
