/**
 * `grenade publish | publish off <link>`: the canvases this computer published to secret links (PROTOCOL.md
 * "Publishing"). Publishing itself is done from an app; this lists what is up and takes a link down.
 */
import type { Command } from "commander";
import type { PublishedLink } from "@grenade/protocol";
import type { Control } from "./controlClient.js";

export interface PublishCommandDeps {
  control: Control;
}

export function registerPublishCommand(program: Command, d: PublishCommandDeps): void {
  const publish = program
    .command("publish")
    .description("canvases published to secret links: what is up, and taking one down")
    .action(async () => {
      for (const line of publishedLines(await d.control<PublishedLink[]>("GET", "/published"), new Date())) console.log(line);
    });

  publish
    .command("off <link>")
    .description("take a link down (its address, or its token); the page stops working at once")
    .action(async (link: string) => {
      const links = await d.control<PublishedLink[]>("GET", "/published");
      const token = tokenOf(link);
      const found = links.find((l) => l.token === token);
      if (!found) throw new Error(`no published link ${link} on this computer; \`grenade publish\` lists them`);
      await d.control("DELETE", `/published/${found.token}`);
      console.log(`unpublished ${found.title}: ${found.url} no longer works`);
    });
}

/** The token in a link's address, or the token itself. Pure. */
export function tokenOf(link: string): string {
  return /\/c\/([A-Za-z0-9_-]{16})/.exec(link)?.[1] ?? link.trim();
}

/** One block per link, newest first. Pure. */
export function publishedLines(links: PublishedLink[], now: Date): string[] {
  if (links.length === 0) return ["Nothing is published. Publish a canvas from the Mac app's canvas (Publish, in its bar)."];
  return links.flatMap((l) => {
    const shows = l.scope === "newest" ? "newest revision" : "all revisions";
    const state = l.state === "failed" ? `failed: ${l.error ?? ""}` : l.state;
    const expiry = l.expires ? `, expires ${daysLeft(l.expires, now)}` : "";
    return [`${l.title}  ${l.url}`, `  ${state} · ${l.boards} ${l.boards === 1 ? "board" : "boards"} · ${shows}${expiry}`, `  ${l.folder}`];
  });
}

function daysLeft(iso: string, now: Date): string {
  const days = Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}
