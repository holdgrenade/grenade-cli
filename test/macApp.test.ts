import { describe, expect, it } from "vitest";
import {
  MAC_APP_INSTALL_SCRIPT,
  macAppDestination,
  macAppInstallCommand,
  macAppPlaces,
  macAppStatusLines,
  macAppVersion,
  parseMacAppRelease,
} from "../src/app/macApp.js";

const latest = '{"version":"1.0.169","url":"https://downloads.holdgrenade.com/mac/Grenade-1.0.169.dmg","sha256":"e3be3767bdab632d75d41223b32eb9938aad539f563a91f94e7078930466896a"}';

describe("parseMacAppRelease", () => {
  it("reads latest.json as publish.sh writes it", () => {
    expect(parseMacAppRelease(latest)).toEqual({
      version: "1.0.169",
      url: "https://downloads.holdgrenade.com/mac/Grenade-1.0.169.dmg",
      sha256: "e3be3767bdab632d75d41223b32eb9938aad539f563a91f94e7078930466896a",
    });
  });

  it("takes nothing it cannot check", () => {
    expect(parseMacAppRelease("not json")).toBeNull();
    expect(parseMacAppRelease("[]")).toBeNull();
    expect(parseMacAppRelease(latest.replace("https://downloads.holdgrenade.com/", "http://downloads.holdgrenade.com/"))).toBeNull();
    expect(parseMacAppRelease(latest.replace("https://downloads.holdgrenade.com/", "https://example.com/"))).toBeNull();
    expect(parseMacAppRelease(latest.replace(/"sha256":"[0-9a-f]+"/, '"sha256":"abc"'))).toBeNull();
    expect(parseMacAppRelease(latest.replace('"version":"1.0.169"', '"version":"latest"'))).toBeNull();
    expect(parseMacAppRelease(latest.replace(".dmg", ".pkg"))).toBeNull();
  });
});

describe("where the app is and goes", () => {
  it("looks in /Applications, then the home folder's", () => {
    expect(macAppPlaces("/Users/sam")).toEqual(["/Applications/Grenade.app", "/Users/sam/Applications/Grenade.app"]);
  });

  it("goes to /Applications, or the home folder's when that is not writable", () => {
    expect(macAppDestination("/Users/sam", true)).toBe("/Applications/Grenade.app");
    expect(macAppDestination("/Users/sam", false)).toBe("/Users/sam/Applications/Grenade.app");
  });

  it("reads the version plutil prints for an installed copy", () => {
    expect(macAppVersion("1.0.169\n")).toBe("1.0.169");
    expect(macAppVersion("")).toBeNull();
    expect(macAppVersion("No value at that key path")).toBeNull();
  });
});

describe("the install", () => {
  const release = parseMacAppRelease(latest)!;

  it("runs the script with the address, the checksum and the destination, nothing from the shell", () => {
    expect(macAppInstallCommand(release, "/Applications/Grenade.app")).toEqual([
      "/bin/sh",
      "-c",
      MAC_APP_INSTALL_SCRIPT,
      "grenade-app-install",
      release.url,
      release.sha256,
      "/Applications/Grenade.app",
    ]);
  });

  it("checks the checksum and Gatekeeper's verdict before copying, and cleans up on the way out", () => {
    const script = MAC_APP_INSTALL_SCRIPT;
    const at = (needle: string) => {
      const i = script.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at("set -eu")).toBe(0);
    expect(at('shasum -a 256 "$tmp/Grenade.dmg"')).toBeLessThan(at("hdiutil attach"));
    expect(at("hdiutil attach")).toBeLessThan(at("codesign --verify --deep --strict"));
    expect(at("codesign --verify --deep --strict")).toBeLessThan(at("spctl --assess --type execute"));
    expect(at("spctl --assess --type execute")).toBeLessThan(at("ditto"));
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain('if [ -e "$dest" ]; then');
  });
});

describe("macAppStatusLines", () => {
  it("says where the app is, or how to get it", () => {
    expect(macAppStatusLines({ path: "/Applications/Grenade.app", version: "1.0.169" })).toEqual(["Grenade 1.0.169 is at /Applications/Grenade.app. It updates itself."]);
    expect(macAppStatusLines(null)).toEqual(["The Grenade Mac app is not installed.", "Install it with: grenade app install, or brew install --cask holdgrenade/tap/grenade-app"]);
  });

  it("has no app to offer on Linux", () => {
    expect(macAppStatusLines(null, "linux")[0]).toMatch(/runs on a Mac/);
  });
});
