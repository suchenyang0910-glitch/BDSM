import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScriptEnvFiles } from "./utils/scriptEnv.js";

const currentFile = fileURLToPath(import.meta.url);
const serverRoot = path.resolve(path.dirname(currentFile), "..");
const shouldOverrideExisting = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

loadScriptEnvFiles({
  cwd: serverRoot,
  overrideExisting: shouldOverrideExisting,
});
