import { describe, expect, it } from "vitest";
import {
  behaviorDimensionValue,
  buildBehaviorFingerprint,
  buildOutgoingBehaviorFingerprint,
  canonicalBehaviorValue
} from "./behaviorFingerprint.js";

describe("behaviorFingerprint", () => {
  it("separates invocation, payload arguments, guards and forwarded context", () => {
    const fingerprint = buildBehaviorFingerprint({
      reference_id: "reference-1",
      target: { file: "target.ts", symbol: "Target" },
      location: { file: "entry.ts", line: 12, column: 3 },
      kind: "indirect",
      invocation: "executor.run(alias)",
      target_path: "destination",
      payload_expression: "{ destination: Target, params: { mode: 'safe' }, context: { navigator, dispatch } }",
      arguments: [
        { parameter: "arg1", expression: "alias", provided: true },
        { parameter: "payload.destination", expression: "Target", provided: true },
        { parameter: "payload.params", expression: "{ mode: 'safe' }", provided: true },
        { parameter: "payload.context", expression: "{ navigator, dispatch }", provided: true }
      ],
      preconditions: ["after guard: NOT (!isAllowed(user))"]
    });

    expect(behaviorDimensionValue(fingerprint, "invocation")).toEqual({
      kind: "indirect",
      callee: "executor.run",
      target_path: "destination"
    });
    expect(behaviorDimensionValue(fingerprint, "arguments")).toEqual({
      destination: "Target",
      params: "{ mode: 'safe' }",
      context: "{ navigator, dispatch }"
    });
    expect(fingerprint.context).toEqual(expect.arrayContaining([
      "navigator",
      "dispatch",
      "isAllowed",
      "user"
    ]));
    expect(fingerprint.side_effects).toEqual([
      "delivers:destination",
      "indirect:executor.run"
    ]);
    expect(fingerprint.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves route payloads and guards from an entry function outgoing call", () => {
    const fingerprint = buildOutgoingBehaviorFingerprint({
      reference_id: "entry-outgoing-1",
      target: { file: "Target.tsx", symbol: "Target" },
      call: {
        location: { file: "routes.ts", line: 18, column: 5 },
        kind: "call",
        callee: "navigator.push",
        invocation: "navigator.push({ component: Target, params: { mode: 'safe' }, context: { navigator, dispatch } })",
        arguments: [{
          parameter: "arg1",
          expression: "{ component: Target, params: { mode: 'safe' }, context: { navigator, dispatch } }",
          provided: true
        }],
        preconditions: ["isLoggedIn(user)"]
      }
    });

    expect(behaviorDimensionValue(fingerprint, "destination")).toEqual({
      file: "Target.tsx",
      symbol: "Target"
    });
    expect(behaviorDimensionValue(fingerprint, "arguments")).toEqual({
      component: "Target",
      params: "{ mode: 'safe' }",
      context: "{ navigator, dispatch }"
    });
    expect(fingerprint.invocation).toMatchObject({
      kind: "indirect",
      callee: "navigator.push",
      target_path: "component"
    });
    expect(fingerprint.preconditions).toEqual(["isLoggedIn(user)"]);
    expect(fingerprint.context).toEqual(expect.arrayContaining(["navigator", "dispatch", "isLoggedIn", "user"]));
  });

  it("canonicalizes object keys without erasing semantic values", () => {
    expect(canonicalBehaviorValue({ b: 2, a: { y: "safe", x: 1 } }))
      .toBe(canonicalBehaviorValue({ a: { x: 1, y: "safe" }, b: 2 }));
    expect(canonicalBehaviorValue({ mode: "safe" }))
      .not.toBe(canonicalBehaviorValue({ mode: "fast" }));
  });
});
