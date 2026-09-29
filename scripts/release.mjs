// Builds what gets installed on a user's Mac: one self-contained package with no dependencies to fetch.
//   release/grenade-remote-<version>/   package.json, dist/cli.js (the CLI, the daemon, @grenade/protocol and every
//                                       library in one file), README.md, LICENSE
//   release/grenade-remote-<version>.tgz   the same, packed; what `npm install -g` and the Homebrew formula take
//   packaging/homebrew/grenade.rb       the formula, with this tarball's version and sha256
// Nothing is published. Run: npm run release
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { formula } from "../packaging/homebrew/formula.mjs";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const NAME = "grenade-remote";
const dir = join(root, "release", `${NAME}-${pkg.version}`);
const tarball = join(root, "release", `${NAME}-${pkg.version}.tgz`);

// The backend imports the protocol's dist, so that is built first.
execFileSync("npm", ["run", "build"], { cwd: join(root, "..", "grenade-protocol"), stdio: "inherit" });

rmSync(dir, { recursive: true, force: true });
rmSync(tarball, { force: true });
mkdirSync(join(dir, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(dir, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Optional native speed-ups of `ws`. It works without them.
  external: ["bufferutil", "utf-8-validate"],
  // Libraries written as CommonJS call `require` for Node's own modules; an ES module has none until it makes one.
  banner: { js: 'import { createRequire as grenadeCreateRequire } from "node:module";\nconst require = grenadeCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(join(dir, "dist", "cli.js"), 0o755);

writeFileSync(
  join(dir, "package.json"),
  JSON.stringify(
    {
      name: NAME,
      version: pkg.version,
      description: "Watch and drive AI coding agents (Claude Code, Codex, a shell) in your Mac's terminals from your phone.",
      type: "module",
      bin: { grenade: "dist/cli.js" },
      files: ["dist", "README.md", "LICENSE"],
      engines: pkg.engines,
      os: ["darwin"],
      license: pkg.license,
    },
    null,
    2,
  ) + "\n",
);
cpSync(join(root, "README.md"), join(dir, "README.md"));
cpSync(join(root, "LICENSE"), join(dir, "LICENSE"));

execFileSync("npm", ["pack", "--pack-destination", join(root, "release")], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(join(root, "packaging", "homebrew", "grenade.rb"), formula({ version: pkg.version, sha256, tarball: `${NAME}-${pkg.version}.tgz` }));

console.log(`package   ${dir}`);
console.log(`tarball   ${tarball}`);
console.log(`sha256    ${sha256}`);
console.log(`formula   packaging/homebrew/grenade.rb`);
