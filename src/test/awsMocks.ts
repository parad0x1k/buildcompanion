import { mockClient } from "aws-sdk-client-mock";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";

/**
 * Shared `aws-sdk-client-mock` stubs for the whole test run.
 *
 * `mockClient(SomeClient)` stubs `SomeClient.prototype.send`, and Sinon throws if the same
 * method is stubbed twice without an intervening `.restore()`. Since Mocha loads (requires)
 * every `*.test.js` file up front before running any of them, two files each calling
 * `mockClient(CodeBuildClient)` at module scope would collide. Creating the stubs exactly once
 * here, and having every test file import and `.reset()` (not re-create) them, avoids that.
 */
export const codeBuildMock = mockClient(CodeBuildClient);
export const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);
