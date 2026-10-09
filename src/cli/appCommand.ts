/**
 * `grenade app`: where the Mac app is, if it is installed; `grenade app install`: the newest one from the terminal
 * (R13D of the root canvas, 2026-10-09), the way `grenade setup` offers it. On Linux there is no app to install.
 */
import type { Command } from "commander";
import { MAC_APP_CASK_COMMAND, macAppStatusLines } from "../app/macApp.js";
import { fetchMacAppRelease, installedMacApp, installMacApp, macAppDestinationHere } from "../app/installMacApp.js";

export function registerAppCommand(program: Command): void {
  const app = program.command("app").description("the Grenade Mac app: is it installed, and install it");

  app
    .command("status", { isDefault: true })
    .description("where the Mac app is, if it is installed")
    .action(() => {
      for (const line of macAppStatusLines(process.platform === "darwin" ? installedMacApp() : null, process.platform)) console.log(line);
    });

  app
    .command("install")
    .description(`download the newest Mac app, check it and put it in Applications (or: ${MAC_APP_CASK_COMMAND})`)
    .action(async () => {
      if (process.platform !== "darwin") throw new Error(macAppStatusLines(null, process.platform).join(" "));
      const installed = installedMacApp();
      if (installed) {
        for (const line of macAppStatusLines(installed)) console.log(line);
        return;
      }
      await installTheMacApp();
    });
}

/** Downloads, checks, copies and opens the newest release, saying what it does. Setup calls it too. Throws on a failure. */
export async function installTheMacApp(): Promise<void> {
  const release = await fetchMacAppRelease();
  const destination = macAppDestinationHere();
  console.log(`Downloading Grenade ${release.version} and checking it…`);
  installMacApp(release, destination);
  console.log(`ok: installed ${destination} and opened it`);
}
