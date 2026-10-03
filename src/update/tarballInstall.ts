/**
 * A copy installed from the release's tarball, without a package manager: what `install.sh` on the website lays down
 * on Linux. `<data home>/grenade/package/` is the tarball as it unpacks, and `~/.local/bin/grenade` links to its
 * `dist/cli.js`. It depends on no Node version's global folder, so changing Node (mise, nvm) does not lose it.
 *
 * Bringing it up to date is the same steps again, as one shell script: read the tap's formula (the release Homebrew
 * installs, with its sha256), download that tarball, check it against the sha256, unpack it beside the old copy and
 * swap the two. The link keeps pointing at the same path. Pure: the script is text, `installer.ts` runs it.
 */

/** The folder that holds `package/`, from the resolved path of the `grenade` command. Null for any other layout. */
export function tarballRoot(resolvedProgram: string): string | null {
  return resolvedProgram.match(/^(.*\/grenade)\/package\/dist\/cli\.js$/)?.[1] ?? null;
}

/** `$1` is the root, `$2` the formula's address. It fails without touching the installed copy until the last three lines. */
export const TARBALL_INSTALL_SCRIPT = `set -eu
root=$1
formula=$(curl -fsSL "$2")
url=$(printf '%s\\n' "$formula" | sed -n 's/^ *url "\\(https:\\/\\/github\\.com\\/holdgrenade\\/grenade-cli\\/releases\\/download\\/[^"]*\\)"$/\\1/p' | head -n 1)
sha=$(printf '%s\\n' "$formula" | sed -n 's/^ *sha256 "\\([0-9a-f]\\{64\\}\\)"$/\\1/p' | head -n 1)
if [ -z "$url" ] || [ -z "$sha" ]; then echo "no release is listed" >&2; exit 1; fi
tmp=$(mktemp -d "$root/.new.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/grenade.tgz" "$url"
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/grenade.tgz" | cut -d" " -f1); else got=$(shasum -a 256 "$tmp/grenade.tgz" | cut -d" " -f1); fi
if [ "$got" != "$sha" ]; then echo "its checksum does not match" >&2; exit 1; fi
tar -xzf "$tmp/grenade.tgz" -C "$tmp"
test -f "$tmp/package/dist/cli.js"
chmod +x "$tmp/package/dist/cli.js"
rm -rf "$root/package.old"
if [ -d "$root/package" ]; then mv "$root/package" "$root/package.old"; fi
mv "$tmp/package" "$root/package"
rm -rf "$root/package.old"
`;

/** The one command that installs the latest release into `root`. */
export function tarballInstallCommand(root: string, formulaUrl: string): string[] {
  return ["/bin/sh", "-c", TARBALL_INSTALL_SCRIPT, "grenade-update", root, formulaUrl];
}
