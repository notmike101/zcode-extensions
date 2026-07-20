import {afterEach, describe, expect, test} from "bun:test";
import os from "node:os";
import path from "node:path";
import {JsonLogger} from "../src/shared/logger.ts";
import {ZCodeProtocolClient} from "../src/protocol/client.ts";

const clients: ZCodeProtocolClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.stop())); });

describe("ZCode Protocol client", () => {
  test("handles responses, notifications, and reverse interaction requests", async () => {
    const client = new ZCodeProtocolClient({
      executable: process.execPath,
      args: [path.join(import.meta.dir, "fixtures", "mock-app-server.ts")],
      cwd: path.resolve(import.meta.dir, ".."),
      logger: new JsonLogger(path.join(os.tmpdir(), `zdp-protocol-${process.pid}.log`), "test"),
      requestHandler: async (method) => ({action: method.includes("UserInput") ? "cancel" : "deny"}),
    });
    clients.push(client);
    await client.start();
    expect(await client.request<{pong: boolean}>("ping", {})).toEqual({pong: true});
    expect(await client.request<{interaction: {action: string}}>("interaction-test", {})).toEqual({interaction: {action: "cancel"}});
    const notified = new Promise<string>((resolve) => client.once("notification", (method: string) => resolve(method)));
    await client.request("notify", {});
    expect(await notified).toBe("session/event");
  });
});
