import { describe, expect, it } from "vitest";
import { canvasLines } from "../src/cli/canvasCommand.js";

describe("canvasLines", () => {
  it("lists the group's canvases, then a new one after the highest number", () => {
    const lines = canvasLines("/p/.grenade/canvas/g-1", [
      { canvas: "canvas-1", name: "Macros", boards: 4 },
      { canvas: "canvas-3", name: "Tags", boards: 1 },
      { canvas: "shared", name: "Shared", boards: 9 },
    ]);
    expect(lines).toEqual([
      "/p/.grenade/canvas/g-1/canvas-1  Macros (4 boards)",
      "/p/.grenade/canvas/g-1/canvas-3  Tags (1 board)",
      "/p/.grenade/canvas/g-1/canvas-4  a new canvas (make the folder)",
    ]);
  });

  it("offers canvas-1 to a group with none", () => {
    expect(canvasLines("/p/.grenade/canvas/g-1", [])).toEqual(["/p/.grenade/canvas/g-1/canvas-1  a new canvas (make the folder)"]);
  });
});
