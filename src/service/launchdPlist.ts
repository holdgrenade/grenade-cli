/**
 * The launchd agent that keeps grenaded running: its label, where its file lives, and the plist itself. Pure.
 * launchd starts it at login and again whenever it dies; `launchd.ts` does the I/O.
 */
import { join } from "node:path";

export const SERVICE_LABEL = "com.adamchew.grenade.daemon";
/** launchd waits this long before it starts a job that just exited. */
export const RESTART_DELAY_S = 10;

export interface ServiceSpec {
  label: string;
  /** Absolute path of the `grenade` command. The stable one on PATH, never a versioned Cellar path. */
  program: string;
  /** Arguments after the program, `daemon` first. */
  args: string[];
  /** PATH of the user's login shell: launchd's own is bare, and agents started in tmux inherit the daemon's. */
  path: string;
  /** Extra environment (GRENADE_HOME for a test install, SHELL). */
  env: Record<string, string>;
  /** Where launchd sends what the daemon prints outside its own log (a crash before the logger is up). */
  logPath: string;
}

export function plistPath(home: string, label: string = SERVICE_LABEL): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/** `gui/<uid>/<label>`: the job's name for `launchctl print`, `bootout` and `kickstart`. */
export function serviceTarget(uid: number, label: string = SERVICE_LABEL): string {
  return `${domainTarget(uid)}/${label}`;
}

/** `gui/<uid>`: the login session's domain, which has the Keychain (`claude` needs it for summaries). */
export function domainTarget(uid: number): string {
  return `gui/${uid}`;
}

export function renderPlist(s: ServiceSpec): string {
  const env = { ...s.env, PATH: s.path };
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t<string>${xml(s.label)}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...[s.program, ...s.args].map((a) => `\t\t<string>${xml(a)}</string>`),
    `\t</array>`,
    `\t<key>EnvironmentVariables</key>`,
    `\t<dict>`,
    ...Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([k, v]) => [`\t\t<key>${xml(k)}</key>`, `\t\t<string>${xml(v)}</string>`]),
    `\t</dict>`,
    `\t<key>RunAtLoad</key>`,
    `\t<true/>`,
    // Restart after a crash or a kill. A clean exit (launchctl bootout, `service remove`) stays stopped.
    `\t<key>KeepAlive</key>`,
    `\t<dict>`,
    `\t\t<key>SuccessfulExit</key>`,
    `\t\t<false/>`,
    `\t</dict>`,
    `\t<key>ThrottleInterval</key>`,
    `\t<integer>${RESTART_DELAY_S}</integer>`,
    // tmux must outlive the daemon: without this launchd kills what the job left behind when it stops.
    `\t<key>AbandonProcessGroup</key>`,
    `\t<true/>`,
    `\t<key>LimitLoadToSessionType</key>`,
    `\t<string>Aqua</string>`,
    `\t<key>ProcessType</key>`,
    `\t<string>Interactive</string>`,
    `\t<key>StandardOutPath</key>`,
    `\t<string>${xml(s.logPath)}</string>`,
    `\t<key>StandardErrorPath</key>`,
    `\t<string>${xml(s.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * The PATH the agent runs with: the login shell's, then the usual homes of node, tmux and claude in case the
 * shell profile did not run (a failed capture), without duplicates and without empty entries.
 */
export function servicePath(loginPath: string | undefined, home: string, nodeDir: string): string {
  const fallback = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const seen = new Set<string>();
  return [...(loginPath ?? "").split(":"), ...fallback].filter((p) => p.startsWith("/") && !seen.has(p) && seen.add(p)).join(":");
}

/**
 * The command launchd runs. A Homebrew install resolves to `<prefix>/Cellar/grenade/<version>/…`, which is gone after
 * the next upgrade, so the unversioned `<prefix>/bin/grenade` is used in its place. Anything else runs as it is.
 */
export function stableProgram(resolved: string): string {
  const cellar = resolved.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\//);
  return cellar ? `${cellar[1]}/bin/${cellar[2]}` : resolved;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
