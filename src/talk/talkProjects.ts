/**
 * Where `create_session` may start a session and what it takes from the agent, checked. Pure, tested. Mirrors the
 * apps' `VoiceProjects` and `VoiceNewSession`: the agent names a project by its folder's name and never sees or
 * supplies a path; the title becomes the session's name through the daemon's own slug rule; nothing it supplies
 * reaches a shell.
 *
 * Known folders on the daemon: those of its sessions that are still running, then those of the agents' recent
 * conversations (what the apps' New Session sheet offers without typing). Home and `/` are not projects.
 */
import { sessionIdFor, slugify } from "../tmux/parse.js";
import { folderNameOf } from "./talkSessions.js";

export const MAX_TITLE_CHARACTERS = 60;
export const MAX_PURPOSE_CHARACTERS = 200;
/** How many projects the agent is told about. */
export const MAX_PROJECTS = 30;

export interface TalkProject {
  /** An absolute path. */
  path: string;
  /** The folder's own name: what the agent says and is told. */
  name: string;
}

export type ProjectMatch = { one: TalkProject } | { none: true } | { several: TalkProject[] } | { path: true };

/** The known folders, newest use first, each once, without home and `/`. */
export function knownProjects(folders: readonly string[], home: string): TalkProject[] {
  const seen = new Set<string>();
  const projects: TalkProject[] = [];
  for (const raw of folders) {
    const path = raw.replace(/\/+$/, "") || "/";
    if (path === home || path === "/" || seen.has(path)) continue;
    seen.add(path);
    projects.push({ path, name: folderNameOf(path) });
    if (projects.length >= MAX_PROJECTS) break;
  }
  return projects;
}

/** The project a name means: the folder's name, whole, ignoring case, accents and the spaces around it. */
export function matchProject(wanted: string, projects: readonly TalkProject[]): ProjectMatch {
  const name = wanted.trim();
  if (looksLikePath(name)) return { path: true };
  const found = projects.filter((p) => p.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0);
  if (found.length === 0) return { none: true };
  if (found.length === 1) return { one: found[0]! };
  return { several: found };
}

/** Anything with a slash, a tilde or a parent step in it. */
export function looksLikePath(text: string): boolean {
  return text.includes("/") || text.includes("\\") || text.startsWith("~") || text.includes("..");
}

/** The names the agent is given, each once, in the order known. */
export function projectNames(projects: readonly TalkProject[]): string[] {
  return [...new Set(projects.map((p) => p.name))];
}

export interface NewSessionRequest {
  title: string;
  purpose: string;
  project: string;
  /** One line, capped as a send is. Null when none was given. */
  firstPrompt: string | null;
}

/** The checked request, or the sentence that says what is wrong with it. */
export function checkNewSession(args: Record<string, unknown>, sendable: (text: string) => string | null): NewSessionRequest | { problem: string } {
  const title = oneLine(args["title"]);
  const purpose = oneLine(args["purpose"]);
  const project = typeof args["project_context"] === "string" ? args["project_context"].trim() : "";
  if (!title) return { problem: "create_session needs a title." };
  if (title.length > MAX_TITLE_CHARACTERS) return { problem: `The title is longer than ${MAX_TITLE_CHARACTERS} characters. Shorten it.` };
  if (!purpose) return { problem: "create_session needs a purpose." };
  if (purpose.length > MAX_PURPOSE_CHARACTERS) return { problem: `The purpose is longer than ${MAX_PURPOSE_CHARACTERS} characters. Shorten it.` };
  if (!project) return { problem: "create_session needs a project_context." };
  const first = typeof args["initial_prompt"] === "string" ? sendable(args["initial_prompt"]) : null;
  return { title, purpose, project, firstPrompt: first };
}

/** The session's name: the title through the slug rule, with -2, -3, … while a live session has it. */
export function sessionNameFor(title: string, liveIds: ReadonlySet<string>): string {
  const base = slugify(title);
  let candidate = base;
  for (let n = 2; liveIds.has(sessionIdFor(candidate)); n++) {
    // Room for the suffix: a name is cut at 40.
    const suffix = `-${n}`;
    candidate = base.slice(0, 40 - suffix.length) + suffix;
  }
  return candidate;
}

/**
 * The agent to start: the one the folder's newest session runs, unless that is a shell or one this computer cannot
 * start; then Claude Code when it can, else the first coding agent. Never a shell: there a first prompt would run as a
 * command. Null when no coding agent can start.
 */
export function agentForNewSession(folderAgent: string | undefined, coding: readonly string[]): string | null {
  if (folderAgent && coding.includes(folderAgent)) return folderAgent;
  if (coding.includes("claude")) return "claude";
  return coding[0] ?? null;
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.split(/\r?\n|\r/).join(" ").trim() : "";
}
