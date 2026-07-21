import {describe, expect, test} from "bun:test";
import {OFFICIAL_EXTENSIONS} from "../src/host/extension-catalog.ts";

describe("official extension catalog", () => {
  test("uses unique ids and immutable HTTPS release-feed locations", () => {
    expect(new Set(OFFICIAL_EXTENSIONS.map(({id}) => id)).size).toBe(OFFICIAL_EXTENSIONS.length);
    for (const extension of OFFICIAL_EXTENSIONS) {
      const repository = new URL(extension.repositoryUrl);
      const manifest = new URL(extension.manifestUrl);
      expect(repository.protocol).toBe("https:");
      expect(repository.hostname).toBe("github.com");
      expect(manifest.protocol).toBe("https:");
      expect(manifest.hostname).toBe("github.com");
      expect(manifest.pathname).toBe(`/${repository.pathname.slice(1)}/releases/latest/download/extension-update.json`);
    }
  });

  test("lists Token Speed by its public release feed", () => {
    expect(OFFICIAL_EXTENSIONS).toContainEqual({
      id: "zcode-tps",
      name: "Token Speed",
      description: "Show live estimates and exact provider-reported token throughput for ZCode sessions.",
      repositoryUrl: "https://github.com/notmike101/zcode-tps-extension",
      manifestUrl: "https://github.com/notmike101/zcode-tps-extension/releases/latest/download/extension-update.json",
    });
  });
});
