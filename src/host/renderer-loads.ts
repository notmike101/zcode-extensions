export type RendererLoadEmitter = {
  on(event: "did-finish-load", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
};

export function observeRendererLoads(
  contents: RendererLoadEmitter,
  onLoad: () => void | Promise<void>,
  onDestroyed: () => void,
): void {
  contents.on("did-finish-load", () => { void onLoad(); });
  contents.once("destroyed", onDestroyed);
}
