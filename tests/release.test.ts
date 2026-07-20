import {describe, expect, test} from "bun:test";
import {assertReleaseVersion, releaseBaseName} from "../scripts/release-helpers.ts";

describe("release metadata", () => {
  test("accepts a matching semantic version tag", () => {
    expect(assertReleaseVersion("v0.1.2", "0.1.2", "0.1.2")).toBe("0.1.2");
    expect(releaseBaseName("0.1.2")).toBe("zcode-extensions-v0.1.2-windows-x64");
  });

  test("rejects malformed or inconsistent release versions", () => {
    expect(() => assertReleaseVersion("release-0.1.2", "0.1.2", "0.1.2")).toThrow("strict vX.Y.Z");
    expect(() => assertReleaseVersion("v0.1.3", "0.1.2", "0.1.2")).toThrow("does not match project version");
    expect(() => assertReleaseVersion("v0.1.2", "0.1.2", "0.1.1")).toThrow("does not match HOST_VERSION");
  });
});
