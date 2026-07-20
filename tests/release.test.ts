import {describe, expect, test} from "bun:test";
import {assertReleaseVersion, releaseBaseName} from "../scripts/release-helpers.ts";

describe("release metadata", () => {
  test("accepts a matching semantic version tag", () => {
    expect(assertReleaseVersion("v0.2.0", "0.2.0", "0.2.0")).toBe("0.2.0");
    expect(releaseBaseName("0.2.0")).toBe("zcode-extensions-v0.2.0-windows-x64");
  });

  test("rejects malformed or inconsistent release versions", () => {
    expect(() => assertReleaseVersion("release-0.2.0", "0.2.0", "0.2.0")).toThrow("strict vX.Y.Z");
    expect(() => assertReleaseVersion("v0.2.1", "0.2.0", "0.2.0")).toThrow("does not match project version");
    expect(() => assertReleaseVersion("v0.2.0", "0.2.0", "0.1.9")).toThrow("does not match HOST_VERSION");
  });
});
