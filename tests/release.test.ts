import {describe, expect, test} from "bun:test";
import {assertReleaseVersion, releaseBaseName, resolveReleaseTag} from "../scripts/release-helpers.ts";

describe("release metadata", () => {
  test("accepts a matching semantic version tag", () => {
    expect(assertReleaseVersion("v0.2.0", "0.2.0", "0.2.0")).toBe("0.2.0");
    expect(releaseBaseName("0.2.0")).toBe("zcode-extensions-v0.2.0-windows-x64");
  });

  test("ignores pull-request merge refs when inferring a release tag", () => {
    expect(resolveReleaseTag(undefined, undefined, "1/merge", "0.2.0")).toBe("v0.2.0");
    expect(resolveReleaseTag(undefined, "branch", "main", "0.2.0")).toBe("v0.2.0");
    expect(resolveReleaseTag(undefined, "tag", "v0.2.0", "0.2.0")).toBe("v0.2.0");
    expect(resolveReleaseTag("v0.2.1", "tag", "v0.2.0", "0.2.0")).toBe("v0.2.1");
  });

  test("rejects malformed or inconsistent release versions", () => {
    expect(() => assertReleaseVersion("release-0.2.0", "0.2.0", "0.2.0")).toThrow("strict vX.Y.Z");
    expect(() => assertReleaseVersion("v0.2.1", "0.2.0", "0.2.0")).toThrow("does not match project version");
    expect(() => assertReleaseVersion("v0.2.0", "0.2.0", "0.1.9")).toThrow("does not match HOST_VERSION");
  });
});
