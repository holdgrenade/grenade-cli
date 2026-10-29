// Writes dist/version.json: the version this build is (`builtVersion` in src/update/installedVersion.ts). Run by
// `npm run build` after tsc, so a pull that moves package.json on does not change what the daemon says it runs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(root, "dist", "version.json"), JSON.stringify({ version }) + "\n");
