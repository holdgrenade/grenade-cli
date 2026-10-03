/** What `grenade service` asks of whatever keeps grenaded running: launchd on a Mac, systemd on Linux. Types only. */

export type ServiceManager = "launchd" | "systemd";

export interface ServiceOptions {
  /** The service's name: a launchd label, or a systemd unit without `.service`. */
  label?: string;
  /** Arguments for `grenade`, `daemon` first. */
  args: string[];
  /** Extra environment for the daemon (GRENADE_HOME when it is not the default). */
  env: Record<string, string>;
  /** Folder for the manager's own log (`launchd.log`, `systemd.log`). */
  logDir: string;
  /** The `grenade` command as it was started (`process.argv[1]`). */
  program: string;
}

export interface ServiceState {
  /** The manager knows the service (its file is loaded). */
  loaded: boolean;
  running: boolean;
  pid?: number;
  /** Exit code of the last run, when the manager reports one. */
  lastExit?: number;
}

export interface ServiceStatus extends ServiceState {
  /** The service's file is on disk. */
  installed: boolean;
  /** The plist in ~/Library/LaunchAgents, or the unit in ~/.config/systemd/user. */
  file: string;
  label: string;
  manager: ServiceManager;
}
