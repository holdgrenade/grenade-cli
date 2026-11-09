import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CODEX_SANDBOX_INSTRUCTIONS, codexInstructions, codexInstructionsFlag, grenadeInstructions } from "../src/agents/agentInstructions.js";
import { topLevelTomlString } from "../src/agents/codexUserConfig.js";
import { unreachableMessage } from "../src/cli/controlClient.js";
import { BROWSER_INSTRUCTIONS } from "../src/browser/browserPrompt.js";
import { CANVAS_INSTRUCTIONS } from "../src/canvas/canvasPrompt.js";
import { TODO_INSTRUCTIONS } from "../src/todos/todoPrompt.js";

describe("grenadeInstructions", () => {
  it("tells every agent about the canvas and the to-dos, and on a Mac the browser first", () => {
    expect(grenadeInstructions(false)).toBe(`${CANVAS_INSTRUCTIONS}\n\n${TODO_INSTRUCTIONS}`);
    expect(grenadeInstructions(true)).toBe(`${BROWSER_INSTRUCTIONS}\n\n${CANVAS_INSTRUCTIONS}\n\n${TODO_INSTRUCTIONS}`);
  });

  it("names Codex's file tool for boards, not only Claude Code's", () => {
    expect(CANVAS_INSTRUCTIONS).toContain("apply_patch");
  });
});

describe("codexInstructions", () => {
  it("adds the sandbox's rule after Grenade's", () => {
    expect(codexInstructions(false)).toBe(`${grenadeInstructions(false)}\n\n${CODEX_SANDBOX_INSTRUCTIONS}`);
  });

  it("keeps the user's own developer instructions, first", () => {
    const text = codexInstructions(true, "  Always answer in French.\n");
    expect(text.startsWith("Always answer in French.\n\n")).toBe(true);
    expect(text).toContain(BROWSER_INSTRUCTIONS);
    expect(codexInstructions(true, "   ")).toBe(codexInstructions(true));
  });
});

describe("codexInstructionsFlag", () => {
  it("is one shell word holding a TOML basic string that reads back as the text", () => {
    const text = `It's "quoted"\nwith a tab\t, a backslash \\ and a DEL \x7f.`;
    const flag = codexInstructionsFlag(text);
    const words = JSON.parse(execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${flag} | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").trimEnd().split("\\n")))'`], { encoding: "utf8" })) as string[];
    expect(words[0]).toBe("-c");
    const value = words.slice(1).join("\n");
    expect(value.startsWith("developer_instructions=")).toBe(true);
    expect(value).not.toContain("\x7f");
    expect(topLevelTomlString(value, "developer_instructions")).toBe(text);
  });
});

describe("topLevelTomlString", () => {
  it("reads each of TOML's string forms", () => {
    expect(topLevelTomlString('developer_instructions = "a \\"b\\"\\n\\u00e9"', "developer_instructions")).toBe('a "b"\né');
    expect(topLevelTomlString("developer_instructions = 'C:\\path'", "developer_instructions")).toBe("C:\\path");
    expect(topLevelTomlString('developer_instructions = """\nline one\nline two\\\n   joined"""', "developer_instructions")).toBe("line one\nline twojoined");
    expect(topLevelTomlString("developer_instructions = '''\nraw \\n here'''", "developer_instructions")).toBe("raw \\n here");
    expect(topLevelTomlString('developer_instructions = """say ""hi"""""', "developer_instructions")).toBe('say ""hi""');
  });

  it("reads only the top level, before the first table", () => {
    const text = 'model = "gpt-6-luna"\n\n[profiles.work]\ndeveloper_instructions = "not this"\n';
    expect(topLevelTomlString(text, "developer_instructions")).toBeNull();
    expect(topLevelTomlString(`${'developer_instructions = "this"\n'}${text}`, "developer_instructions")).toBe("this");
  });

  it("steps over another key's multi-line string", () => {
    const text = 'notes = """\ndeveloper_instructions = "inside"\n"""\ndeveloper_instructions = "outside"\n';
    expect(topLevelTomlString(text, "developer_instructions")).toBe("outside");
  });

  it("gives none for a missing key, a non-string or a string that never ends", () => {
    expect(topLevelTomlString('model = "x"', "developer_instructions")).toBeNull();
    expect(topLevelTomlString("developer_instructions = 3", "developer_instructions")).toBeNull();
    expect(topLevelTomlString('developer_instructions = "open', "developer_instructions")).toBeNull();
    expect(topLevelTomlString('developer_instructions = """open', "developer_instructions")).toBeNull();
  });
});

describe("unreachableMessage", () => {
  it("says how to get through Codex's sandbox, and otherwise that grenaded is not running", () => {
    expect(unreachableMessage({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toContain("escalated permissions");
    expect(unreachableMessage({})).toContain("grenaded is not running");
  });
});
