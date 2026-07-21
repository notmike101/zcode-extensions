import {readFile} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..", "..");
const port = Number(process.env.ZDP_RENDERER_HARNESS_PORT ?? 43120);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/harness.html") {
      return new Response(await readFile(path.join(root, "tests", "fixtures", "renderer-harness.html")), {
        headers: {"content-type": "text/html; charset=utf-8"},
      });
    }
    if (url.pathname === "/renderer/index.js") {
      return new Response(await readFile(path.join(root, "runtime", "versions", "0.3.4", "renderer", "index.js")), {
        headers: {"content-type": "text/javascript; charset=utf-8"},
      });
    }
    return new Response("Not found", {status: 404});
  },
});

console.log(`Renderer harness listening at ${server.url}`);
