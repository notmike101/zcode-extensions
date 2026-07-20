#!/usr/bin/env bun
import {DEFAULT_ZCODE_ROOT, HOST_VERSION} from "../shared/constants.ts";
import {doctor, installOrRepair, launch, uninstall} from "./installer.ts";
import {guard} from "./guardian.ts";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const zcodeRoot = valueAfter("--zcode") ?? DEFAULT_ZCODE_ROOT;

try {
  switch (command) {
    case "doctor": {
      const report = await doctor(zcodeRoot);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
      break;
    }
    case "install":
    case "repair": {
      const report = await installOrRepair(zcodeRoot);
      console.log(`${command === "install" ? "Installed" : "Repaired"} ZCode Desktop Extensions for ZCode ${report.zcodeVersion}.`);
      console.log(`Vendor ASAR: ${report.vendorAsarSha256}`);
      break;
    }
    case "launch": await launch(zcodeRoot, args.includes("--safe")); break;
    case "uninstall":
      await uninstall(zcodeRoot, args.includes("--purge-data"));
      console.log(`Uninstalled ZCode Desktop Extensions${args.includes("--purge-data") ? " and removed its data" : " (data preserved)"}.`);
      break;
    case "guard": {
      const parent = Number(valueAfter("--parent"));
      if (!Number.isInteger(parent) || parent <= 0) throw new Error("guard requires --parent <pid>");
      await guard(parent, zcodeRoot);
      break;
    }
    case "help":
    case "--help":
    case "-h": printHelp(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`ZCode Desktop Extensions ${HOST_VERSION}\n\nCommands:\n  doctor\n  install\n  repair\n  launch [--safe]\n  uninstall [--purge-data]\n\nOptions:\n  --zcode <path>  Override the ZCode installation directory`);
}
