import { describe, expect, it } from "vitest";
import { parsePidList, parsePsTable, processTree } from "../src/tmux/processes.js";

describe("process tree", () => {
  it("parses pane pids and ps output", () => {
    expect(parsePidList("123\n456\n\n1\nx\n")).toEqual([123, 456]);
    expect(parsePsTable("  1     0\n 123     1\n 200   123\nbad\n")).toEqual([[1, 0], [123, 1], [200, 123]]);
  });

  it("returns every descendant, children before parents, and never init", () => {
    const table: [number, number][] = [[1, 0], [100, 1], [101, 100], [102, 101], [103, 100], [900, 1]];
    expect(processTree(table, [100])).toEqual([102, 101, 103, 100]);
    expect(processTree(table, [1])).toEqual([]);
  });
});
