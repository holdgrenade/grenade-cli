/**
 * What `grenade setup` says about push notifications. They are a setting of the daemon that follows remote access
 * unless someone chose otherwise: on while the Mac uses a relay, off on a Mac that talks to none. Pure.
 */
export interface PushSetting {
  enabled: boolean;
  /** What was chosen: `auto` follows remote access. Absent from a daemon that predates it. */
  mode?: "on" | "off" | "auto";
  /** The relay pushes are posted to. */
  gateway?: string;
}

export function pushNotice(push: PushSetting, computer: string = "Mac"): string[] {
  if (!push.enabled && push.mode === "auto") {
    return [
      `Push notifications are off, because remote access is off: this ${computer} talks to no relay.`,
      `The phone notifies by itself while the app runs. To be told while it is closed: grenade relay on turns on`,
      `remote access and push; grenade push on turns on push alone, through the main relay, which then learns this`,
      `${computer}'s public IP address, the phone's device token and the time, never the session or the text.`,
    ];
  }
  if (!push.enabled) return ["Push notifications are off. Turn them on with: grenade push on"];
  return [
    `Push notifications are on: when an agent needs you or has finished, this ${computer} posts a sealed notification to`,
    `${push.gateway ?? "a relay"}, which hands it to Apple. That relay learns this ${computer}'s public IP address,`,
    `the phone's device token and the time, never the session or the text.`,
    push.mode === "auto" ? `They go off with remote access (grenade relay off). Turn only them off with: grenade push off` : `Turn them off with: grenade push off`,
  ];
}
