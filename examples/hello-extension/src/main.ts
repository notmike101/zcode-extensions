import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import type {ExtensionContext, ExtensionDisposable} from "../../../sdk/index.ts";

type GreetingState = {count: number};

export async function activate(context: ExtensionContext): Promise<ExtensionDisposable> {
  await mkdir(context.dataDir, {recursive: true});
  const stateFile = path.join(context.dataDir, "state.json");
  const state = await readState(stateFile);

  const greetingHandler = context.ipc.handle("greet", async (payload) => {
    const name = readName(payload);
    state.count += 1;
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const result = {
      message: `Hello, ${name}! This extension has greeted someone ${state.count} time${state.count === 1 ? "" : "s"}.`,
      count: state.count,
    };
    context.ipc.emit("greeted", result);
    return result;
  });

  const resumeHandler = context.lifecycle.onResume(() => {
    void context.logger.info("The desktop resumed while Hello Extension was active");
  });

  await context.logger.info("Hello Extension activated", {stateFile});

  return {
    dispose: async () => {
      await greetingHandler.dispose();
      await resumeHandler.dispose();
      await context.logger.info("Hello Extension disposed");
    },
  };
}

async function readState(filePath: string): Promise<GreetingState> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as {count?: unknown};
    return {count: typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 ? value.count : 0};
  } catch {
    return {count: 0};
  }
}

function readName(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("name" in payload)) return "ZCode";
  const value = String((payload as {name: unknown}).name).trim();
  return value.slice(0, 80) || "ZCode";
}
