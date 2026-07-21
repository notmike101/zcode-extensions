# ZCode Desktop Extensions

[![CI](https://github.com/notmike101/zcode-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/notmike101/zcode-extensions/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/notmike101/zcode-extensions)](https://github.com/notmike101/zcode-extensions/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> [!IMPORTANT]
> **This project was entirely AI-generated using GPT-5.6 Sol.**

ZCode Desktop Extensions is an external, installable extension host for the ZCode Electron desktop application. It adds an **Extensions** entry directly below **Skills**, keeps extension code and state outside the ZCode installation, and survives ZCode updates by reapplying a small fail-open loader around the untouched vendor application.

The official [Scheduler extension](https://github.com/notmike101/zcode-scheduler) is versioned and released separately. It can be installed from the host's extension catalog.

This is an independent community project and is not affiliated with or endorsed by ZCode.

## What is included

- An update-resistant Electron loader that preserves the original ZCode `app.asar`.
- A separate extension host with install, enable, disable, reload, and recoverable uninstall operations.
- A checksum-verified extension catalog and updater with next-launch installation and activation-failure rollback.
- Main-process and renderer extension entrypoints with namespaced IPC and lifecycle cleanup.
- The dual ESM/CommonJS [`@notmike101/zcode-extension-sdk`](https://www.npmjs.com/package/@notmike101/zcode-extension-sdk), with browser-safe renderer exports and manifest validation.
- Capability-gated workspace, session, task, model, MCP, usage, broadcast, and experimental private-channel APIs.
- Typed event streams plus stable shadow-root UI slots for pages, navigation, workspaces, tasks, chat, turns, and messages.
- A complete [extension-development guide](docs/extension-development.md).
- A native desktop task bridge so extension-created work appears as ordinary persistent ZCode tasks.
- A guardian that detects updater-provided ZCode application bundles and reapplies the loader after ZCode exits.
- Doctor, repair, safe-mode, launch, and uninstall commands.

## Requirements

- Windows x64.
- ZCode installed at `C:\Users\<you>\AppData\Local\Programs\ZCode`, or supplied with `--zcode`.
- ZCode 3.3.6 or a compatible later version. The current release is tested against 3.3.6.
- Bun 1.3.14 or newer only when building from source. Release users do not need Bun.

Release executables are currently unsigned. Windows SmartScreen may warn before the first launch; verify the release checksum and only continue if it matches.

## Install from a release

1. Close ZCode completely.
2. Download the Windows ZIP and matching `.sha256` file from the [latest release](https://github.com/notmike101/zcode-extensions/releases/latest).
3. Verify the archive:

   ```powershell
   $zip = ".\zcode-extensions-v0.3.3-windows-x64.zip"
   $expected = (Get-Content "$zip.sha256").Split()[0].ToLowerInvariant()
   $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
   if ($actual -ne $expected) { throw "Checksum mismatch" }
   ```

4. Extract the archive to a permanent location. The ZIP contains a stable `zcode-extensions` directory:

   ```powershell
   Expand-Archive .\zcode-extensions-v0.3.3-windows-x64.zip -DestinationPath D:\
   Set-Location D:\zcode-extensions
   ```

5. Install and launch:

   ```powershell
   .\bin\zdp.exe install
   .\bin\zdp.exe launch
   ```

The installer updates the existing Start Menu ZCode shortcut to use `zdp-launcher.exe` and records the original shortcut metadata for uninstall. Keep the extracted directory in place: it contains the runtime, extensions, logs, backups, and extension data.

For a non-default ZCode installation, append `--zcode "D:\Path\To\ZCode"` to commands.

## Use the extension manager

Open **Extensions** in ZCode's normal navigation, directly below **Skills**.

- **Installed** lists extensions, checks for updates, and provides install, enable/disable, reload, and uninstall actions.
- **Available** lists official extensions such as Scheduler and installs checksum-verified release bundles.
- **Health** shows the loader, extension host, native ZCode task service, data paths, and recent logs.
- Extension-provided pages appear beneath the host pages after installation.

To install a third-party extension, choose **Install extension** and select a folder containing a valid `.zdp\plugin.json` manifest and its built entrypoints. Extensions are trusted local code with the same file and process access as the host; install only code you trust.

## Scheduler

Install Scheduler from **Extensions → Available**, restart ZCode, then open **Extensions → Scheduler → New job**. Each job supports:

- A standard five-field cron expression: minute, hour, day of month, month, and day of week.
- An IANA timezone such as `America/Chicago`.
- A workspace, prompt, and ZCode permission mode: Plan, Build, Edit, or Yolo.
- Optional timeout, thought level, provider, model, and variant selection.
- Overlap handling: skip, queue one, or run in parallel.
- Immediate runs, pause/resume, duplicate, edit, delete, and bounded run history.

Scheduler behavior is application-scoped:

- ZCode must remain open at the scheduled time.
- Missed runs are skipped instead of replayed after restart or resume.
- It uses Electron timers and IANA timezones, not Windows Task Scheduler.
- Every run is a normal persistent ZCode task named `⏰ Job name`; it appears immediately in the standard sidebar, can be opened while running, remains after completion, and archives normally.
- Scheduler History retains scheduling-specific status and timing alongside the native task.

Scheduler source, releases, and issue tracking live in the separate [zcode-scheduler repository](https://github.com/notmike101/zcode-scheduler).

## Updating extensions

The host checks official and extension-declared update feeds at startup, every six hours, and whenever **Check for updates** is selected. Selecting **Install update** downloads the ZIP over HTTPS, validates its declared size and SHA-256 checksum, checks compatibility and bundle paths, and queues it for the next launch. Extension data under `data\plugin-data` is not part of the bundle and is preserved.

Queued updates replace only the extension bundle on startup. The previous bundle moves to recoverable trash; if an enabled extension fails to activate, the host rolls back automatically. Updates never modify ZCode's vendor ASAR.

## Updating ZCode Desktop Extensions

Close ZCode, download the new release, and extract it over the same parent directory:

```powershell
Expand-Archive .\zcode-extensions-v0.3.3-windows-x64.zip -DestinationPath D:\ -Force
Set-Location D:\zcode-extensions
.\bin\zdp.exe repair
.\bin\zdp.exe launch
```

The release archive does not contain `data`, so extension configuration and Scheduler jobs remain in place. Repair preserves the untouched ZCode vendor bundle, refreshes the managed loader, and retains bounded backups.

After a ZCode application update, allow ZCode to exit normally so the guardian can detect the new vendor `app.asar`. Run `doctor` and then `repair` if the health check reports a problem.

## Operational commands

Run commands from the extracted project root:

| Command | Purpose |
| --- | --- |
| `bin\zdp.exe doctor` | Inspect the vendor ASAR, loader, runtime, shortcut, Electron fuses, and compatibility. |
| `bin\zdp.exe install` | Perform the first installation. ZCode must be closed. |
| `bin\zdp.exe repair` | Reapply the current loader/runtime after a build or update. |
| `bin\zdp.exe launch` | Repair if needed, launch ZCode, and start the guardian. |
| `bin\zdp.exe launch --safe` | Launch the untouched ZCode application without initializing extensions. |
| `bin\zdp.exe uninstall` | Restore the vendor ASAR and original shortcut while preserving data. |
| `bin\zdp.exe uninstall --purge-data` | Also remove extensions, jobs, logs, and backups. |

Install, repair, and uninstall refuse to run while ZCode is open. The installer also refuses to replace an Electron `resources\app` directory it does not recognize as managed by this project.

## How update resistance works

1. The installer moves ZCode's `resources\app.asar` to `resources\zcode.original.asar`.
2. It stores a SHA-256-identified backup under `data\backups`.
3. It creates a minimal managed Electron loader at `resources\app`.
4. The loader starts the external extension host and imports the untouched vendor ASAR.
5. A guardian watches for an updater-provided `app.asar` after ZCode exits, backs it up, and reapplies the loader.

If the extension host fails, the loader records the error and still attempts to open the vendor application. This design is update-resistant, not update-proof: ZCode can change Electron behavior, navigation markup, fuses, or its private desktop service APIs.

## Files and data

| Path | Contents |
| --- | --- |
| `bin` | Generated CLI and launcher executables. Release assets only; never committed. |
| `runtime` | Generated versioned host and renderer bundles. |
| `data\plugins` | Installed extension bundles. The plugin-named path is retained for API compatibility. |
| `data\plugin-data\<id>` | Private persistent data for each extension. |
| `data\logs` | Loader and host JSONL logs with bounded rotation. |
| `data\backups` | The three newest hash-identified ZCode vendor backups. |
| `data\.trash` | Recoverable extension bundles removed or superseded during upgrades. |
| `data\.staging` | Verified extension updates waiting for the next launch. |

Scheduler jobs live in `data\plugin-data\scheduler\jobs.json` and history in `history.jsonl`.

## Build from source

```powershell
git clone https://github.com/notmike101/zcode-extensions.git
Set-Location zcode-extensions
bun install --frozen-lockfile
bun run check
```

`bun run check` typechecks the project, runs the test suite, builds the Hello Extension example, and produces the host runtime plus Windows executables. Close ZCode before rebuilding an installed checkout because the guardian may hold `bin\zdp.exe` open.

Useful commands:

```powershell
bun run typecheck
bun test
bun run build:example
bun run build
bun run build:sdk
bun run pack:sdk
bun run release:package -- --tag v0.3.3
```

See [Developing extensions](docs/extension-development.md) for the public API and [Hello Extension](examples/hello-extension) for a complete minimal project.

## Compatibility identifiers

The product is called **ZCode Desktop Extensions**, but several API and storage identifiers retain their original plugin wording so existing installations remain compatible:

- `.zdp\plugin.json`
- `plugin:invoke` and `plugin:<extension-id>:<event>`
- `window.ZDP_REGISTER_PLUGIN_RENDERER`
- `data\plugins` and `data\plugin-data`
- The legacy `zdp` executable and environment-variable prefix

These names are part of API version 1 and should not be renamed by extension authors.

## Troubleshooting and recovery

- **ZCode is running:** close every ZCode window and wait briefly for the guardian to exit.
- **The Extensions item is missing:** run `bin\zdp.exe doctor`, then close ZCode and run `repair`.
- **An extension fails to load:** inspect **Extensions → Health**, validate its manifest and compatibility ranges, rebuild its entrypoints, and use **Reload**.
- **ZCode fails with extensions enabled:** run `bin\zdp.exe launch --safe` and disable or uninstall the offending extension.
- **A ZCode update replaced the loader:** exit ZCode normally so the guardian can repair it, or run `repair` manually.
- **Full rollback:** run `bin\zdp.exe uninstall`. Add `--purge-data` only when extension data and backups should also be removed.

## Releases

Generated executables and runtime bundles are excluded from Git. A Windows GitHub Actions workflow validates tagged `vX.Y.Z` releases, builds from a clean checkout, creates a portable ZIP and SHA-256 file, and publishes them as GitHub Release assets.

## License

[MIT](LICENSE) © 2026 notmike101
