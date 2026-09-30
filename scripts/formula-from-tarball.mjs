// Writes packaging/homebrew/grenade.rb for a tarball that is already on the GitHub release, so the sha256 in the tap is
// of the very file brew will download, whatever a later build of the same version would hash to.
// Run: node scripts/formula-from-tarball.mjs <path to holdgrenade-cli-<version>.tgz>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { formula } from "../packaging/homebrew/formula.mjs";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/formula-from-tarball.mjs <tarball>");
const tarball = basename(path);
const expected = `holdgrenade-cli-${pkg.version}.tgz`;
if (tarball !== expected) throw new Error(`${tarball} is not the tarball of version ${pkg.version} (${expected})`);

const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(join(root, "packaging", "homebrew", "grenade.rb"), formula({ version: pkg.version, sha256, tarball }));
console.log(`formula   packaging/homebrew/grenade.rb`);
console.log(`sha256    ${sha256}  ${tarball}`);
