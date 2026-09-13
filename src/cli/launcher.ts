import {spawn} from "node:child_process";
import path from "node:path";
import {ZDP_EXECUTABLE} from "../shared/constants.ts";

const root = path.dirname(path.dirname(process.execPath));
const child = spawn(path.join(root, "bin", ZDP_EXECUTABLE), ["launch", ...process.argv.slice(2)], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: {...process.env, ZDP_ROOT: root},
});
child.unref();
