import {describe, expect, test} from "bun:test";
import {EventEmitter} from "node:events";
import {observeRendererLoads} from "../src/host/renderer-loads.ts";

describe("renderer load observation", () => {
  test("reinjects after every load and disposes once", () => {
    const contents = new EventEmitter();
    let loads = 0;
    let destroyed = 0;

    observeRendererLoads(contents, () => { loads += 1; }, () => { destroyed += 1; });
    contents.emit("did-finish-load");
    contents.emit("did-finish-load");
    contents.emit("destroyed");
    contents.emit("destroyed");

    expect(loads).toBe(2);
    expect(destroyed).toBe(1);
  });
});
