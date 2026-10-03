/**
 * The systemd user unit that keeps grenaded running on Linux: its name, where its file lives, and the unit itself.
 * Pure. systemd starts it at login and again whenever it dies; `systemd.ts` does the I/O.
 */
import { join } from "node:path";

/** The unit is `<label>.service`; a test install takes another label. */
export const UNIT_LABEL = "grenade";
/** systemd waits this long before it starts a service that just failed, like the launchd agent. */
export const RESTART_DELAY_S = 10;
/** Set in the unit's environment: with `SYSTEMD_EXEC_PID` it tells the daemon that systemd will start it again. */
export const SERVICE_MARKER = "GRENADE_SERVICE";

export interface UnitSpec {
  label: string;
  /** Absolute path of the `grenade` command. */
  program: string;
  /** Arguments after the program, `daemon` first. */
  args: string[];
  /** PATH of the user's login shell: systemd's own is bare, and agents started in tmux inherit the daemon's. */
  path: string;
  /** Extra environment (GRENADE_HOME for a test install, SHELL). */
  env: Record<string, string>;
  /** Where systemd sends what the daemon prints outside its own log (a crash before the logger is up). */
  logPath: string;
}

export function unitName(label: string = UNIT_LABEL): string {
  return `${label}.service`;
}

/** `$XDG_CONFIG_HOME/systemd/user/<label>.service`, else under `~/.config`. */
export function unitPath(home: string, label: string = UNIT_LABEL, configHome?: string): string {
  const config = configHome && configHome.startsWith("/") ? configHome : join(home, ".config");
  return join(config, "systemd", "user", unitName(label));
}

export function renderUnit(s: UnitSpec): string {
  const env = { ...s.env, PATH: s.path, [SERVICE_MARKER]: s.label };
  const lines = [
    `[Unit]`,
    `Description=Grenade daemon (grenaded)`,
    ``,
    `[Service]`,
    `ExecStart=${[s.program, ...s.args].map(execWord).join(" ")}`,
    ...Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}`),
    // Restart after a crash, a kill or the exit code that asks for it. A clean exit (`service remove`) stays stopped.
    `Restart=on-failure`,
    `RestartSec=${RESTART_DELAY_S}`,
    // tmux must outlive the daemon: by default systemd kills everything the service started when it stops. The
    // daemon starts the tmux server in a scope of its own (`tmux/serverScope.ts`); this covers one that still got in here.
    `KillMode=process`,
    `StandardOutput=append:${specifiers(s.logPath)}`,
    `StandardError=append:${specifiers(s.logPath)}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
  ];
  return lines.join("\n") + "\n";
}

/** One word of `ExecStart=`: as it is when plain, else in double quotes. systemd would expand `$` there. */
function execWord(s: string): string {
  const safe = specifiers(s).replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_/.:=@,+%-]+$/.test(safe) ? safe : `"${escaped(safe)}"`;
}

/** A value in double quotes, for `Environment=`, where `$` means nothing. */
function quoted(s: string): string {
  return `"${escaped(specifiers(s))}"`;
}

function escaped(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** `%` starts a specifier (`%h`, `%u`) in a unit file; `%%` is the character. */
function specifiers(s: string): string {
  return s.replace(/%/g, "%%");
}
