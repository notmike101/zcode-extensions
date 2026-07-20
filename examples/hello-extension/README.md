# Hello Extension

This is the minimal, typed example for the [ZCode Desktop Extensions developer guide](../../docs/extension-development.md).

Build it from the repository root:

```powershell
bun run build:example
```

Then open **Extensions → Installed → Install extension** in ZCode and select this folder. The host copies the folder, so rebuild here and reinstall or copy the rebuilt `dist` directory into the installed development copy before using **Reload**.
