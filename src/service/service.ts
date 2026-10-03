/**
 * `grenade service` on whichever system this is: the launchd agent on a Mac (`launchd.ts`), the systemd user service
 * on Linux (`systemd.ts`). Callers never name a manager; `ServiceStatus.manager` says which one answered.
 */
import * as launchd from "./launchd.js";
import { SERVICE_LABEL } from "./launchdPlist.js";
import type { ServiceManager, ServiceOptions, ServiceStatus } from "./serviceTypes.js";
import * as systemd from "./systemd.js";
import { UNIT_LABEL } from "./systemdUnit.js";

export type { ServiceManager, ServiceOptions, ServiceStatus } from "./serviceTypes.js";

export function serviceManager(platform: string = process.platform): ServiceManager {
  return platform === "darwin" ? "launchd" : "systemd";
}

/** The service's name when none is given: the launchd label, or the systemd unit without `.service`. */
export function defaultLabel(platform: string = process.platform): string {
  return serviceManager(platform) === "launchd" ? SERVICE_LABEL : UNIT_LABEL;
}

const manager = () => (serviceManager() === "launchd" ? launchd : systemd);

export function installService(o: ServiceOptions): Promise<ServiceStatus> {
  return manager().installService(o);
}

export function removeService(label: string = defaultLabel()): Promise<boolean> {
  return manager().removeService(label);
}

export function serviceStatus(label: string = defaultLabel()): Promise<ServiceStatus> {
  return manager().serviceStatus(label);
}

export function restartService(label: string = defaultLabel()): Promise<void> {
  return manager().restartService(label);
}
