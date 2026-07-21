import {describe, expect, test} from "bun:test";
import type {DesktopServiceConnection, DesktopServicePort} from "../src/protocol/desktop-service.ts";
import {ZCodeGateway} from "../src/protocol/zcode-gateway.ts";
import {JsonLogger} from "../src/shared/logger.ts";

describe("ZCode gateway", () => {
  test("deduplicates subscriptions and replays from the last sequence after reconnect", async () => {
    const entry1 = entry("one");
    const entry2 = entry("two");
    let current = entry1;
    let changed: (entry: DesktopServicePort | undefined) => void = () => undefined;
    const broker = {
      current: () => current,
      waitForPort: async () => current,
      onChange(listener: typeof changed) { changed = listener; return {dispose() {}}; },
      dispose() {},
    };
    const first = connection();
    const second = connection();
    const gateway = new ZCodeGateway({
      vendorAsar: "unused",
      portBroker: broker,
      logger: new JsonLogger("unused-gateway-test.log", "test"),
      connect: async (port) => port === entry1.port ? first.value : second.value,
    });

    const received: unknown[] = [];
    const left = gateway.subscribe("zcode-session", "onDynamicSessionEvent", {sessionId: "session-1"}, (value) => received.push(["left", value]));
    const right = gateway.subscribe("zcode-session", "onDynamicSessionEvent", {sessionId: "session-1"}, (value) => received.push(["right", value]));
    await Bun.sleep(0);
    expect(first.listenCount).toBe(1);
    first.emit({type: "session.event", event: {seq: 4}});
    expect(received).toHaveLength(2);
    first.emit({type: "session.event", event: {seq: 4}});
    first.emit({type: "session.event", event: {seq: 3}});
    expect(received).toHaveLength(2);
    first.emit({type: "session.event", event: {seq: 5}});
    expect(received).toHaveLength(4);

    current = entry2;
    changed(entry2);
    await Bun.sleep(0);
    expect(second.listenCount).toBe(1);
    expect(second.lastArgument).toMatchObject({sessionId: "session-1", afterSeq: 5, includeSnapshot: true});

    left.dispose();
    expect(second.disposeCount).toBe(0);
    right.dispose();
    expect(second.disposeCount).toBe(1);
    await gateway.shutdown();
  });
});

function entry(id: string): DesktopServicePort {
  return {port: {id} as never, process: {id} as never};
}

function connection() {
  let listener: (value: unknown) => void = () => undefined;
  let listenCount = 0;
  let disposeCount = 0;
  let lastArgument: unknown;
  const channel = {
    async call() { return undefined; },
    listen(_event: string, argument?: unknown) {
      listenCount += 1;
      lastArgument = argument;
      return (next: (value: unknown) => void) => {
        listener = next;
        return {dispose() { disposeCount += 1; }};
      };
    },
  };
  const value = {
    broadcast: {}, session: {}, task: {},
    channel: () => channel,
    service: () => ({}),
    dispose() {},
  } as DesktopServiceConnection;
  return {
    value,
    emit: (event: unknown) => listener(event),
    get listenCount() { return listenCount; },
    get disposeCount() { return disposeCount; },
    get lastArgument() { return lastArgument; },
  };
}
