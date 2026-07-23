import {render} from "preact";
import {useEffect, useMemo, useRef, useState} from "preact/hooks";
import type {CatalogExtensionStatus, HostState, PluginStatus} from "../shared/schemas.ts";
import type {RendererPlugin, ZdpBridge} from "./globals.d.ts";
import {RendererExtensionRuntime} from "./extension-runtime.ts";
import styles from "./styles.css";

const bridge = window.zcodeDesktopPlugins;
if (!bridge) throw new Error("ZCode Desktop Extensions preload bridge is unavailable");

const modules = window.__zdpRendererPlugins ?? new Map<string, RendererPlugin>();
window.__zdpRendererPlugins = modules;
const extensionRuntime = new RendererExtensionRuntime(bridge);
let nativeNavigationUpdateCount = 0;
window.ZDP_REGISTER_PLUGIN_RENDERER = (plugin) => {
  modules.set(plugin.id, plugin);
  extensionRuntime.register(plugin);
  window.dispatchEvent(new CustomEvent("zdp-renderer-registered", {detail: plugin.id}));
};

let host = document.getElementById("zdp-host");
if (!host) {
  host = document.createElement("div");
  host.id = "zdp-host";
  document.documentElement.append(host);
}
const shadow = host.shadowRoot ?? host.attachShadow({mode: "open"});
const style = document.createElement("style");
style.textContent = styles;
const mount = document.createElement("div");
shadow.replaceChildren(style, mount);
render(<DesktopPluginsApp bridge={bridge}/>, mount);

function DesktopPluginsApp({bridge}: {bridge: ZdpBridge}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<HostState | null>(null);
  const [activePage, setActivePage] = useState("plugins");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [rendererRevision, setRendererRevision] = useState(0);
  const [updateNotice, setUpdateNotice] = useState<string>();

  const refresh = async () => {
    try {
      const next = await bridge.invoke<HostState>("host:getState");
      window.__zdpHostState = next;
      extensionRuntime.sync(next.plugins);
      setState(next);
      loadRendererScripts(next.plugins);
      setError(undefined);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  useEffect(() => {
    void refresh();
    const remove = bridge.on((event) => {
      if (event === "host-state-changed") void refresh();
      if (event.startsWith("plugin:")) window.dispatchEvent(new CustomEvent(event));
    });
    const registered = () => setRendererRevision((value) => value + 1);
    window.addEventListener("zdp-renderer-registered", registered);
    return () => {
      remove();
      window.removeEventListener("zdp-renderer-registered", registered);
    };
  }, []);

  useEffect(() => installNativeNavigationItem(() => setOpen(true)), []);

  const extensionUpdateCount = state?.plugins.filter((plugin) => plugin.update.state === "available").length ?? 0;
  const hostUpdateAvailable = state?.hostUpdate.state === "available" ? 1 : 0;
  const availableUpdateCount = extensionUpdateCount + hostUpdateAvailable;
  useEffect(() => updateNativeNavigationBadge(availableUpdateCount), [availableUpdateCount]);
  useEffect(() => {
    const version = state?.hostUpdate.state === "available" ? state.hostUpdate.latestVersion : undefined;
    if (!version) return;
    const key = `zdp-host-update-noticed:${version}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch { /* notification still works when storage is unavailable */ }
    setUpdateNotice(version);
  }, [state?.hostUpdate.state, state?.hostUpdate.latestVersion]);

  const pages = useMemo(() => state?.plugins.flatMap((plugin) => plugin.enabled
    ? plugin.manifest.pages.map((page) => ({...page, pluginId: plugin.manifest.id}))
    : []) ?? [], [state, rendererRevision]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try { await action(); await refresh(); } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(undefined); }
  };

  return <>
    {updateNotice && <div class="zdp-toast" role="status"><div><strong>Host update {updateNotice} is available</strong><span>Open Extensions to review and install it.</span></div><button onClick={() => { setOpen(true); setActivePage("plugins"); setUpdateNotice(undefined); }}>View</button><button aria-label="Dismiss" onClick={() => setUpdateNotice(undefined)}>×</button></div>}
    {open && <div class="zdp-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section class="zdp-shell" role="dialog" aria-label="ZCode Desktop Extensions">
        <header class="zdp-header">
          <div><h1>ZCode Desktop Extensions</h1><p>{state ? `Host ${state.version} · ZCode ${state.zcodeVersion}` : "Loading…"}</p></div>
          <button class="zdp-icon-button" onClick={() => setOpen(false)} aria-label="Close">×</button>
        </header>
        <div class="zdp-body">
          <nav class="zdp-nav">
            <button class={activePage === "plugins" ? "active" : ""} onClick={() => setActivePage("plugins")}>Installed{availableUpdateCount ? ` (${availableUpdateCount})` : ""}</button>
            <button class={activePage === "available" ? "active" : ""} onClick={() => setActivePage("available")}>Available</button>
            <button class={activePage === "health" ? "active" : ""} onClick={() => setActivePage("health")}>Health</button>
            {pages.map((page) => <button class={activePage === `${page.pluginId}:${page.id}` ? "active" : ""}
              onClick={() => setActivePage(`${page.pluginId}:${page.id}`)}>{page.title}</button>)}
          </nav>
          <main class="zdp-content">
            {error && <div class="zdp-alert"><strong>Action failed</strong><span>{error}</span></div>}
            {activePage === "plugins" && <PluginList state={state} busy={busy} run={run} bridge={bridge}/>} 
            {activePage === "available" && <AvailableExtensions state={state} busy={busy} run={run} bridge={bridge}/>}
            {activePage === "health" && <HealthPage state={state} bridge={bridge}/>} 
            {activePage.includes(":") && <PluginPage key={`${activePage}:${rendererRevision}`} page={activePage} bridge={bridge}/>} 
          </main>
        </div>
      </section>
    </div>}
  </>;
}

function installNativeNavigationItem(open: () => void): () => void {
  let navigationItem: HTMLButtonElement | undefined;
  let scheduledFrame: number | undefined;

  const ensureNavigationItem = () => {
    const skillsButton = findSkillsNavigationButton();
    if (!skillsButton) return;

    const existing = document.querySelector<HTMLButtonElement>("button[data-zdp-navigation-item]");
    if (existing) {
      navigationItem = existing;
      if (skillsButton.nextElementSibling !== existing) skillsButton.insertAdjacentElement("afterend", existing);
      updateNativeNavigationBadge(nativeNavigationUpdateCount);
      return;
    }

    const item = skillsButton.cloneNode(false) as HTMLButtonElement;
    item.setAttribute("data-zdp-navigation-item", "true");
    item.setAttribute("aria-label", "ZCode Desktop Extensions");
    item.removeAttribute("data-testid");
    item.removeAttribute("disabled");
    item.type = "button";
    item.title = "ZCode Desktop Extensions";
    item.replaceChildren(createPluginNavigationIcon(), document.createTextNode("Extensions"));
    item.addEventListener("click", open);
    skillsButton.insertAdjacentElement("afterend", item);
    navigationItem = item;
    updateNativeNavigationBadge(nativeNavigationUpdateCount);
  };

  const scheduleNavigationSync = () => {
    if (scheduledFrame !== undefined) return;
    scheduledFrame = window.requestAnimationFrame(() => {
      scheduledFrame = undefined;
      ensureNavigationItem();
    });
  };

  ensureNavigationItem();
  const observer = new MutationObserver(scheduleNavigationSync);
  observer.observe(document.getElementById("root") ?? document.body, {childList: true, subtree: true});

  return () => {
    observer.disconnect();
    if (scheduledFrame !== undefined) window.cancelAnimationFrame(scheduledFrame);
    navigationItem?.removeEventListener("click", open);
    navigationItem?.remove();
  };
}

function updateNativeNavigationBadge(count: number): void {
  nativeNavigationUpdateCount = count;
  const item = document.querySelector<HTMLButtonElement>("button[data-zdp-navigation-item]");
  if (!item) return;
  const existing = item.querySelector<HTMLElement>("[data-zdp-update-badge]");
  if (count === 0) {
    existing?.remove();
    item.title = "ZCode Desktop Extensions";
    item.setAttribute("aria-label", "ZCode Desktop Extensions");
    return;
  }
  const badge = existing ?? document.createElement("span");
  badge.setAttribute("data-zdp-update-badge", "true");
  badge.textContent = String(count);
  Object.assign(badge.style, {
    marginLeft: "auto",
    minWidth: "18px",
    borderRadius: "999px",
    padding: "1px 5px",
    background: "#5368d8",
    color: "white",
    fontSize: "10px",
    textAlign: "center",
  });
  if (!existing) item.append(badge);
  item.title = `${count} update${count === 1 ? "" : "s"} available`;
  item.setAttribute("aria-label", item.title);
}

function findSkillsNavigationButton(): HTMLButtonElement | undefined {
  const sidebars = [...document.querySelectorAll("aside")];
  for (const sidebar of sidebars) {
    const named = [...sidebar.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getAttribute("data-zdp-navigation-item") === null && button.textContent?.trim().toLocaleLowerCase() === "skills",
    );
    if (named) return named;
  }

  for (const sidebar of sidebars) {
    const navigationGroups = [...sidebar.querySelectorAll<HTMLDivElement>("div")].filter((group) =>
      group.classList.contains("flex-col") && group.classList.contains("gap-1") && group.classList.contains("px-2"),
    );
    for (const group of navigationGroups) {
      const buttons = [...group.children].filter((child): child is HTMLButtonElement =>
        child instanceof HTMLButtonElement && child.getAttribute("data-zdp-navigation-item") === null,
      );
      if (buttons.length >= 2) return buttons.at(-1);
    }
  }
  return undefined;
}

function createPluginNavigationIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "size-4",
    "aria-hidden": "true",
  })) svg.setAttribute(name, value);
  for (const pathData of ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a6 6 0 0 1-12 0V8Z"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

function PluginList({state, busy, run, bridge}: {
  state: HostState | null;
  busy?: string;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  bridge: ZdpBridge;
}) {
  const install = async () => {
    const folder = await bridge.invoke<string | null>("host:choosePluginFolder");
    if (!folder) return;
    const manifest = await bridge.invoke<PluginStatus["manifest"]>("plugin:inspect", {path: folder});
    const declared = manifest.capabilities?.length ? manifest.capabilities.join("\n• ") : "legacy defaults (workspace read, task run, extension pages)";
    if (!window.confirm(`Desktop extensions are trusted local code and can access your files.\n\n${manifest.name} requests:\n• ${declared}\n\nInstall this folder?`)) return;
    await bridge.invoke("plugin:install", {path: folder});
  };
  const check = () => Promise.all([bridge.invoke("host:checkUpdate"), bridge.invoke("extension:checkUpdates")]);
  const applyHostUpdate = async () => {
    const version = state?.hostUpdate.latestVersion ?? "the latest version";
    if (!window.confirm(`Download and verify host ${version}? ZCode will restart only after the update is ready, and the current host will be restored if installation fails.`)) return;
    await bridge.invoke("host:applyUpdate");
  };
  return <div>
    {state?.hostUpdate.state === "available" && <div class="zdp-host-update-banner"><div><strong>Host {state.hostUpdate.latestVersion} is available</strong><span>{state.hostUpdate.installable ? "Download it now, then ZCode will restart to apply it." : "This development checkout cannot update itself; use the release package."}</span></div><div class="zdp-section-actions"><button onClick={() => run("view-host-update", () => bridge.invoke("host:viewUpdate"))}>View release</button>{state.hostUpdate.installable && <button class="zdp-primary" disabled={Boolean(busy)} onClick={() => run("apply-host-update", applyHostUpdate)}>Update and restart</button>}</div></div>}
    {state?.hostUpdate.state === "ready" || state?.hostUpdate.state === "downloading" || state?.hostUpdate.state === "applying" ? <div class="zdp-host-update-banner"><div><strong>Host update {state.hostUpdate.state}</strong><span>{state.hostUpdate.state === "downloading" ? "ZCode will remain open until verification finishes." : "ZCode is preparing to restart."}</span></div></div> : null}
    {state?.hostUpdate.state === "error" && <div class="zdp-update-note warning">Host update failed: {state.hostUpdate.error}</div>}
    <div class="zdp-section-title"><div><h2>Installed extensions</h2><p>Extensions run separately from ZCode's skills, commands, hooks, and MCP integrations.</p></div>
      <div class="zdp-section-actions">
        <button disabled={Boolean(busy)} onClick={() => run("check-updates", check)}>Check for updates</button>
        <button class="zdp-primary" disabled={Boolean(busy)} onClick={() => run("install", install)}>Install folder</button>
      </div></div>
    <div class="zdp-cards">
      {state?.plugins.map((plugin) => <PluginCard plugin={plugin} busy={busy} run={run} bridge={bridge}/>)}
      {state && state.plugins.length === 0 && <div class="zdp-empty">No extensions installed.</div>}
    </div>
  </div>;
}

function PluginCard({plugin, busy, run, bridge}: {
  plugin: PluginStatus;
  busy?: string;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  bridge: ZdpBridge;
}) {
  const key = plugin.manifest.id;
  const queueUpdate = async () => {
    const version = plugin.update.latestVersion ?? "the latest version";
    if (!window.confirm(`Download ${plugin.manifest.name} ${version}? It will be applied the next time ZCode starts.`)) return;
    await bridge.invoke("extension:queueUpdate", {pluginId: key});
  };
  return <article class="zdp-card">
    <div class="zdp-card-head"><div><h3>{plugin.manifest.name}</h3><p>{plugin.manifest.description ?? plugin.manifest.id}</p></div>
      <span class={`zdp-status ${plugin.update.state === "available" || plugin.update.state === "queued" ? "update" : plugin.error ? "error" : plugin.loaded ? "ready" : "idle"}`}>
        {plugin.update.state === "available" ? "Update available" : plugin.update.state === "queued" ? "Update queued" : plugin.error ? "Error" : plugin.loaded ? "Loaded" : "Stopped"}
      </span></div>
    {plugin.error && <pre class="zdp-error-text">{plugin.error}</pre>}
    {plugin.manifest.capabilities?.length ? <div class="zdp-capabilities">
      {plugin.manifest.capabilities.map((capability) => <span key={capability} class={capability.startsWith("experimental.") ? "experimental" : capability.includes(".write") || capability.includes(".generate") ? "write" : ""}>{capability}</span>)}
    </div> : <div class="zdp-update-note warning">Legacy capability defaults: workspace read, task run, and extension pages.</div>}
    {plugin.update.state === "queued" && <div class="zdp-update-note">Version {plugin.update.queuedVersion} is verified and will be applied on the next ZCode launch.</div>}
    {plugin.update.state === "incompatible" && <div class="zdp-update-note warning">Version {plugin.update.latestVersion} requires a different host or ZCode version.</div>}
    {plugin.update.state === "error" && <div class="zdp-update-note warning">Update check failed: {plugin.update.error}</div>}
    <div class="zdp-meta"><span>{plugin.manifest.version}</span><span>{plugin.manifest.id}</span></div>
    <div class="zdp-actions">
      {plugin.update.state === "available" && <button class="zdp-primary" disabled={Boolean(busy)} onClick={() => run(`${key}:update`, queueUpdate)}>Install update</button>}
      {plugin.update.state === "queued" && <button disabled={Boolean(busy)} onClick={() => run(`${key}:cancel-update`, () => bridge.invoke("extension:cancelUpdate", {pluginId: key}))}>Cancel update</button>}
      <button disabled={Boolean(busy)} onClick={() => run(`${key}:toggle`, () => bridge.invoke("plugin:setEnabled", {pluginId: key, enabled: !plugin.enabled}))}>{plugin.enabled ? "Disable" : "Enable"}</button>
      <button disabled={Boolean(busy) || !plugin.enabled} onClick={() => run(`${key}:reload`, () => bridge.invoke("plugin:reload", {pluginId: key}))}>Reload</button>
      <button class="danger" disabled={Boolean(busy)} onClick={() => {
        if (window.confirm(`Uninstall ${plugin.manifest.name}? The bundle will be moved to recoverable trash.`)) {
          void run(`${key}:uninstall`, () => bridge.invoke("plugin:uninstall", {pluginId: key}));
        }
      }}>Uninstall</button>
    </div>
  </article>;
}

function AvailableExtensions({state, busy, run, bridge}: {
  state: HostState | null;
  busy?: string;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  bridge: ZdpBridge;
}) {
  return <div>
    <div class="zdp-section-title"><div><h2>Available extensions</h2><p>Official extensions are downloaded over HTTPS and verified against their published SHA-256 checksum.</p></div>
      <button disabled={Boolean(busy)} onClick={() => run("check-catalog", () => bridge.invoke("extension:checkUpdates"))}>Refresh</button></div>
    <div class="zdp-cards">
      {state?.catalog.map((extension) => <CatalogCard extension={extension} busy={busy} run={run} bridge={bridge}/>) }
      {state && state.catalog.length === 0 && <div class="zdp-empty">No catalog extensions are available.</div>}
    </div>
  </div>;
}

function CatalogCard({extension, busy, run, bridge}: {
  extension: CatalogExtensionStatus;
  busy?: string;
  run: (key: string, action: () => Promise<unknown>) => Promise<void>;
  bridge: ZdpBridge;
}) {
  const install = async () => {
    const manifest = await bridge.invoke<PluginStatus["manifest"]>("catalog:inspect", {pluginId: extension.id});
    const declared = manifest.capabilities?.length ? manifest.capabilities.join("\n• ") : "legacy defaults (workspace read, task run, extension pages)";
    if (!window.confirm(`${extension.name} is trusted local code and can access your files.\n\nIt requests:\n• ${declared}\n\nDownload and install it?`)) return;
    await bridge.invoke("catalog:install", {pluginId: extension.id});
  };
  return <article class="zdp-card">
    <div class="zdp-card-head"><div><h3>{extension.name}</h3><p>{extension.description}</p></div>
      <span class={`zdp-status ${extension.installed ? "ready" : extension.state === "error" || extension.state === "incompatible" ? "error" : "idle"}`}>
        {extension.installed ? "Installed" : extension.state === "checking" ? "Checking" : extension.state === "incompatible" ? "Incompatible" : extension.state === "error" ? "Unavailable" : "Available"}
      </span></div>
    {extension.error && <div class="zdp-update-note warning">{extension.error}</div>}
    <div class="zdp-meta"><span>{extension.latestVersion ?? "Version unavailable"}</span><span>{extension.id}</span></div>
    <div class="zdp-actions">
      {!extension.installed && extension.state === "available" && <button class="zdp-primary" disabled={Boolean(busy)} onClick={() => run(`${extension.id}:catalog-install`, install)}>Install</button>}
    </div>
  </article>;
}

function HealthPage({state, bridge}: {state: HostState | null; bridge: ZdpBridge}) {
  const [logs, setLogs] = useState<string[]>([]);
  useEffect(() => { void bridge.invoke<string[]>("host:getLogs").then(setLogs); }, []);
  return <div><div class="zdp-section-title"><div><h2>Host health</h2><p>Loader, native task service, and local runtime status.</p></div></div>
    <dl class="zdp-health">
      <dt>Extension host</dt><dd>{state ? "Ready" : "Loading"}</dd>
      <dt>Host updates</dt><dd>{state?.hostUpdate.state ?? "unknown"}{state?.hostUpdate.latestVersion ? ` — ${state.hostUpdate.latestVersion}` : ""}</dd>
      <dt>ZCode task service</dt><dd>{state?.health.protocol ?? "unknown"}{state?.health.protocolError ? ` — ${state.health.protocolError}` : ""}</dd>
      <dt>Root</dt><dd>{state?.root}</dd><dt>Data</dt><dd>{state?.dataDir}</dd>
    </dl>
    <h3 class="zdp-log-title">Recent host log</h3><pre class="zdp-log">{logs.length ? logs.join("\n") : "No log entries yet."}</pre>
  </div>;
}

function PluginPage({page, bridge}: {page: string; bridge: ZdpBridge}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const [pluginId, pageId] = page.split(":");
    if (!pluginId || !pageId || !modules.has(pluginId) || !container.current) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void extensionRuntime.mountPage(pluginId, pageId, container.current).then((next) => {
      if (disposed) next();
      else cleanup = next;
    }).catch((error) => {
      if (container.current) container.current.textContent = errorText(error);
    });
    return () => { disposed = true; cleanup?.(); };
  }, [page]);
  const [pluginId] = page.split(":");
  return <div ref={container}>{!modules.has(pluginId) && <div class="zdp-empty">Loading extension page…</div>}</div>;
}

const loadedRendererUrls = new Set<string>();
function loadRendererScripts(plugins: PluginStatus[]): void {
  for (const plugin of plugins) {
    if (!plugin.rendererUrl || loadedRendererUrls.has(plugin.rendererUrl)) continue;
    loadedRendererUrls.add(plugin.rendererUrl);
    const script = document.createElement("script");
    script.src = plugin.rendererUrl;
    script.async = true;
    script.addEventListener("error", () => loadedRendererUrls.delete(plugin.rendererUrl!));
    document.head.append(script);
  }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
