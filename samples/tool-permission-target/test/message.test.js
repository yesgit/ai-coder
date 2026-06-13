import assert from "node:assert/strict";
import test from "node:test";
import { buildMessage } from "../src/message.js";

test("builds a greeting message", () => {
  assert.equal(buildMessage("Claude"), "hello, Claude");
});
