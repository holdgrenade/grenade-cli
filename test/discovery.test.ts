import { describe, expect, it } from "vitest";
import { dnsSdArgs, instanceName } from "../src/daemon/discovery.js";

describe("discovery", () => {
  it("names the instance after the Mac and the daemon id", () => {
    expect(instanceName({ name: "MacBook Pro", id: "d_abc" })).toBe("MacBook Pro (d_abc)");
  });

  it("builds a dns-sd registration with the TXT record the phone reads", () => {
    expect(dnsSdArgs({ name: "MacBook Pro", id: "d_abc", port: 7788, key: "a2V5" })).toEqual([
      "-R", "MacBook Pro (d_abc)", "_grenade._tcp", ".", "7788", "v=1", "id=d_abc", "name=MacBook Pro", "e2e=1", "key=a2V5",
    ]);
  });
});
