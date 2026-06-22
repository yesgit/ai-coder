import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorizedProjects } from "./authorizedProjects.js";

describe("AuthorizedProjects", () => {
  it("authorizes a historical project only when the selected directory matches", async () => {
    const expected = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-expected-"));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-other-"));
    const canonicalExpected = await fs.realpath(expected);
    const projects = new AuthorizedProjects();
    await expect(projects.authorizeMatching(expected, other)).rejects.toThrow("does not match");
    await expect(projects.assertAuthorized(expected)).rejects.toThrow("not authorized");
    await expect(projects.authorizeMatching(expected, expected)).resolves.toBe(canonicalExpected);
    await expect(projects.assertAuthorized(expected)).resolves.toBe(canonicalExpected);
  });
});
