/** `grenade push on | off | status | test`: push notifications for the phones paired with this Mac. */
import type { Command } from "commander";
import { OFFICIAL_RELAY_URL } from "@grenade/protocol";
import { paths } from "../config.js";
import { loadPushConfig, pushConfigOn, savePushConfig } from "../push/pushConfig.js";
import type { PushStatus, TestPushResult } from "../push/pusher.js";
import type { Control } from "./controlClient.js";

export interface PushCommandDeps {
  control: Control;
}

export function registerPushCommand(program: Command, d: PushCommandDeps): void {
  const push = program.command("push").description("tell your phone when an agent needs you or has finished, even while the app is closed");

  push
    .command("on [url]")
    .description("send push notifications, also with remote access off (through the relay this Mac uses, else the main relay)")
    .option("--key <key>", "registration key, for a relay that requires one")
    .option("--at-mac <seconds>", "hold pushes while the Mac was used within this many seconds (0 never holds)", parseSeconds)
    .action(async (url: string | undefined, o: { key?: string; atMac?: number }) => {
      const config = pushConfigOn(loadPushConfig(paths.push), url, o.key);
      if (o.atMac !== undefined) config.atMacSeconds = o.atMac;
      savePushConfig(paths.push, config);
      const s = await d.control<PushStatus>("POST", "/push/reload").catch(() => null);
      if (!s) return console.log("push on (grenaded is not running; it takes effect on the next start)");
      for (const line of statusLines(s)) console.log(line);
      if (s.gateway === OFFICIAL_RELAY_URL) console.log(MAIN_RELAY_NOTE);
    });

  push
    .command("off")
    .description("send no push notifications; phones notify only while the app is running")
    .action(async () => {
      savePushConfig(paths.push, { ...loadPushConfig(paths.push), enabled: false });
      const s = await d.control<PushStatus>("POST", "/push/reload").catch(() => null);
      console.log(s ? "push off: this Mac sends no push notifications" : "push off (grenaded is not running)");
    });

  push
    .command("auto")
    .description("the default: send push notifications while this Mac uses a relay for remote access, none otherwise")
    .action(async () => {
      const { enabled: _chosen, url: _url, key: _key, ...rest } = loadPushConfig(paths.push);
      savePushConfig(paths.push, rest);
      const s = await d.control<PushStatus>("POST", "/push/reload").catch(() => null);
      if (!s) return console.log("push auto (grenaded is not running; it takes effect on the next start)");
      for (const line of statusLines(s)) console.log(line);
    });

  push
    .command("status")
    .description("is push on, through which relay, and which phones asked for it?")
    .action(async () => {
      const s = await d.control<PushStatus>("GET", "/push");
      for (const line of statusLines(s)) console.log(line);
    });

  push
    .command("test")
    .description("send a test notification to every phone that registered")
    .action(async () => {
      const results = await d.control<TestPushResult[]>("POST", "/push/test");
      if (results.length === 0) return console.log("nothing sent: push is off, or no phone has registered yet (open Grenade on the phone and allow notifications)");
      for (const r of results) console.log(`${r.device}  ${testLine(r)}`);
    });
}

/** What a Mac that pushes through the main relay without using it for remote access tells that relay. */
export const MAIN_RELAY_NOTE =
  "This Mac posts each notification, sealed for the phone, to the main relay, which hands it to Apple. That relay learns this Mac's public IP address, the phone's device token and the time, never the session or the text.";

/** Pure: what `grenade push status` prints. */
export function statusLines(s: PushStatus): string[] {
  if (!s.enabled && s.mode === "auto") {
    return [
      "push     off, because remote access is off: this Mac talks to no relay",
      "         grenade relay on   turns on remote access and push",
      "         grenade push on    turns on push alone, through the main relay",
    ];
  }
  if (!s.enabled) return ["push     off. Turn it on with: grenade push on (or grenade push auto: on while remote access is on)"];
  const lines = [`push     on, through ${s.gateway ?? "-"}${s.mode === "auto" ? " (as long as remote access is on)" : ""}`];
  lines.push(`at Mac   ${s.atMacSeconds > 0 ? `held while the Mac was used in the last ${s.atMacSeconds} s` : "never held"}`);
  if (s.devices.length === 0) lines.push("phones   none registered yet (open Grenade on the phone and allow notifications)");
  for (const p of s.devices) lines.push(`phone    ${p.id}  ${p.events.join(" + ") || "nothing"}${p.environment === "sandbox" ? "  (development build)" : ""}`);
  if (s.pending > 0) lines.push(`pending  ${s.pending}`);
  if (s.last) lines.push(`last     ${s.last.outcome}${s.last.error ? ` (${s.last.error})` : ""} to ${s.last.device} at ${new Date(s.last.at).toLocaleTimeString()}`);
  return lines;
}

/** Pure: one phone's line after `grenade push test`. */
export function testLine(r: TestPushResult): string {
  if (r.error === "push_unavailable") return "the relay cannot send pushes (it has no push key and no upstream)";
  switch (r.outcome) {
    case "sent":
      return "sent";
    case "unregistered":
      return "the app was removed from that phone; forgot its registration";
    case "retry":
      return `could not reach the relay or the push service (${r.error ?? "no answer"})`;
    default:
      return `refused (${r.error ?? "unknown"})`;
  }
}

function parseSeconds(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 86_400) throw new Error("--at-mac takes whole seconds, 0 to 86400");
  return n;
}
