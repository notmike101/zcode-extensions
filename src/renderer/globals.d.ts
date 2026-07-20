import type {HostState} from "../shared/schemas.ts";
import type {ExtensionBridge, RendererExtension} from "../../sdk/index.ts";

export type ZdpBridge = ExtensionBridge;
export type RendererPlugin = RendererExtension;

declare global {
  interface Window {
    __zdpRendererPlugins?: Map<string, RendererPlugin>;
    __zdpHostState?: HostState;
  }
}

declare module "*.css" {
  const content: string;
  export default content;
}
