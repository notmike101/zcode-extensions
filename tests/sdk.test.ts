import {expect, test} from "bun:test";
import type {
  ExtensionBridge,
  ExtensionContext,
  ExtensionManifest,
  ExtensionTaskRunHandle,
  RendererExtension,
} from "../sdk/index.ts";
import type {PluginContext} from "../src/host/plugin-manager.ts";
import type {PluginManifest} from "../src/shared/schemas.ts";
import type {TaskRunHandle} from "../src/protocol/task-service.ts";
import type {RendererPlugin, ZdpBridge} from "../src/renderer/globals.d.ts";

type Assert<T extends true> = T;
type Equivalent<Left, Right> =
  Left extends Right
    ? Right extends Left
      ? true
      : false
    : false;

type ContextContract = Assert<Equivalent<PluginContext, ExtensionContext>>;
type ManifestContract = Assert<Equivalent<PluginManifest, ExtensionManifest>>;
type RunHandleContract = Assert<Equivalent<TaskRunHandle, ExtensionTaskRunHandle>>;
type BridgeContract = Assert<Equivalent<ZdpBridge, ExtensionBridge>>;
type RendererContract = Assert<Equivalent<RendererPlugin, RendererExtension>>;

test("the public SDK contract typechecks against the host implementation", () => {
  const contracts: [
    ContextContract,
    ManifestContract,
    RunHandleContract,
    BridgeContract,
    RendererContract,
  ] = [true, true, true, true, true];
  expect(contracts.every(Boolean)).toBe(true);
});
