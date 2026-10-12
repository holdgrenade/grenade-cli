/**
 * Pure: the title a user gives a session (PROTOCOL.md "Session titles"), kept the way `cleanGroupName`
 * keeps a group's name: trimmed, at most `SESSION_TITLE_MAX` long. Undefined, which gives the session
 * back the title it gets by itself, when nothing is left.
 */
import { SESSION_TITLE_MAX } from "@grenade/protocol";

export function cleanSessionTitle(title: string | null): string | undefined {
  const clean = (title ?? "").trim().slice(0, SESSION_TITLE_MAX).trim();
  return clean === "" ? undefined : clean;
}
