/**
 * The Mac app, installed from the terminal (R13D of the root canvas, 2026-10-09): `grenade setup` offers it on a Mac
 * and `grenade app install` does it on request. It reads the release the website links to (`latest.json`: version,
 * DMG and sha256), downloads the DMG, checks the sha256, mounts it quietly, checks the app as Gatekeeper would, copies
 * it to Applications and opens it. Pure: the script is text, `installMacApp.ts` runs it.
 */

/** Where the Mac app's newest release is described; the DMG it names is on the same host. */
export const MAC_APP_LATEST_URL = "https://downloads.holdgrenade.com/mac/latest.json";
const MAC_APP_DOWNLOAD_ORIGIN = "https://downloads.holdgrenade.com/";
/** The other way in, for someone who would rather have Homebrew keep track. */
export const MAC_APP_CASK_COMMAND = "brew install --cask holdgrenade/tap/grenade-app";
export const MAC_APP_NAME = "Grenade.app";

export interface MacAppRelease {
  version: string;
  url: string;
  sha256: string;
}

/** Reads `latest.json`. Null unless it names a version, a DMG on the download host over https, and a sha256. */
export function parseMacAppRelease(text: string): MacAppRelease | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { version, url, sha256 } = data as Record<string, unknown>;
  if (typeof version !== "string" || !/^\d+(\.\d+)+$/.test(version)) return null;
  if (typeof url !== "string" || !url.startsWith(MAC_APP_DOWNLOAD_ORIGIN) || !url.endsWith(".dmg")) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { version, url, sha256 };
}

/** Where a copy may already be, in the order they are looked for. */
export function macAppPlaces(home: string): string[] {
  return [`/Applications/${MAC_APP_NAME}`, `${home}/Applications/${MAC_APP_NAME}`];
}

/** Where a new copy goes: /Applications, or the home folder's Applications when that one is not writable. */
export function macAppDestination(home: string, canWriteApplications: boolean): string {
  return canWriteApplications ? `/Applications/${MAC_APP_NAME}` : `${home}/Applications/${MAC_APP_NAME}`;
}

/** An installed copy's version as `plutil -extract CFBundleShortVersionString raw` prints it, or null for anything else. */
export function macAppVersion(printed: string): string | null {
  const version = printed.trim();
  return /^\d+(\.\d+)+$/.test(version) ? version : null;
}

/**
 * `$1` the DMG's address, `$2` its sha256, `$3` where the app goes (which must not exist). Nothing is left behind on a
 * failure: the image is detached and the download removed on the way out. The app is checked as Gatekeeper would
 * (`spctl`: Developer ID signed and notarized by Apple) before it is copied.
 */
export const MAC_APP_INSTALL_SCRIPT = `set -eu
url=$1
sha=$2
dest=$3
if [ -e "$dest" ]; then echo "there is a Grenade.app at $dest already" >&2; exit 1; fi
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/grenade-app.XXXXXX")
volume="$tmp/volume"
cleanup() {
  if [ -d "$volume" ]; then /usr/bin/hdiutil detach "$volume" -quiet >/dev/null 2>&1 || /usr/bin/hdiutil detach "$volume" -force -quiet >/dev/null 2>&1 || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
curl -fsSL -o "$tmp/Grenade.dmg" "$url"
got=$(/usr/bin/shasum -a 256 "$tmp/Grenade.dmg" | cut -d" " -f1)
if [ "$got" != "$sha" ]; then echo "its checksum does not match" >&2; exit 1; fi
mkdir -p "$volume"
/usr/bin/hdiutil attach "$tmp/Grenade.dmg" -nobrowse -readonly -mountpoint "$volume" -quiet
test -d "$volume/Grenade.app"
/usr/bin/codesign --verify --deep --strict "$volume/Grenade.app"
/usr/sbin/spctl --assess --type execute "$volume/Grenade.app"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest.new"
/usr/bin/ditto "$volume/Grenade.app" "$dest.new"
mv "$dest.new" "$dest"
`;

/** The one command that installs a release at `destination`. */
export function macAppInstallCommand(release: MacAppRelease, destination: string): string[] {
  return ["/bin/sh", "-c", MAC_APP_INSTALL_SCRIPT, "grenade-app-install", release.url, release.sha256, destination];
}

/** What setup says before it asks. */
export function macAppOffer(): string[] {
  return [
    "The Grenade Mac app is a window onto every session on this Mac, next to your terminal.",
    "It is the download from the website: checked against its published checksum and, as Gatekeeper would, for Apple's notarization.",
  ];
}

/** What `grenade app` answers. */
export function macAppStatusLines(installed: { path: string; version: string | null } | null, platform: string = "darwin"): string[] {
  if (platform !== "darwin") return ["The Mac app runs on a Mac. Here, the phone shows every session, and grenade open attaches any terminal."];
  if (!installed) return ["The Grenade Mac app is not installed.", `Install it with: grenade app install, or ${MAC_APP_CASK_COMMAND}`];
  return [`Grenade${installed.version ? ` ${installed.version}` : ""} is at ${installed.path}. It updates itself.`];
}
