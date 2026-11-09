/**
 * The developer instructions the user set in Codex's own `config.toml` (`CODEX_HOME`, else `~/.codex`), so the ones
 * Grenade passes a session (`agentInstructions.ts`) add to them instead of replacing them. Only a top-level
 * `developer_instructions` is read: a profile's is the user's to pick, and a file that cannot be read gives none.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads `config.toml` in `codexDir`; null when there is none, or no top-level `developer_instructions` in it. */
export function readCodexDeveloperInstructions(codexDir: string): string | null {
  try {
    return topLevelTomlString(readFileSync(join(codexDir, "config.toml"), "utf8"), "developer_instructions");
  } catch {
    return null;
  }
}

/**
 * Pure: the value of a string key set before the file's first table (`[…]`), in any of TOML's four string forms.
 * Null when the key is not there, is not a string, or its string does not end.
 */
export function topLevelTomlString(text: string, key: string): string | null {
  const keyLine = new RegExp(`^[ \\t]*(?:${escape(key)}|"${escape(key)}")[ \\t]*=[ \\t]*`);
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    const line = text.slice(at, end < 0 ? text.length : end);
    if (/^[ \t]*\[/.test(line)) return null;
    const m = keyLine.exec(line);
    if (m) return stringAt(text, at + m[0].length);
    if (end < 0) return null;
    // A multi-line string of another key may hold a line that looks like ours: step over it whole.
    at = skipValue(text, at, line, end + 1);
  }
  return null;
}

/** Where the next line starts after `line`, past the end of a multi-line string that opens on it. */
function skipValue(text: string, at: number, line: string, next: number): number {
  const eq = /^[^=#]*=[ \t]*/.exec(line);
  if (!eq) return next;
  const start = at + eq[0].length;
  for (const quote of ['"""', "'''"]) {
    if (!text.startsWith(quote, start)) continue;
    const close = closingOf(text, start + 3, quote);
    if (close < 0) return text.length;
    const after = text.indexOf("\n", close + 3);
    return after < 0 ? text.length : after + 1;
  }
  return next;
}

function stringAt(text: string, start: number): string | null {
  if (text.startsWith('"""', start)) {
    const close = closingOf(text, start + 3, '"""');
    return close < 0 ? null : unescapeBasic(trimFirstNewline(text.slice(start + 3, close)), true);
  }
  if (text.startsWith("'''", start)) {
    const close = text.indexOf("'''", start + 3);
    return close < 0 ? null : trimFirstNewline(text.slice(start + 3, close));
  }
  if (text[start] === '"') {
    const close = closingOf(text, start + 1, '"');
    if (close < 0) return null;
    const body = text.slice(start + 1, close);
    return body.includes("\n") ? null : unescapeBasic(body, false);
  }
  if (text[start] === "'") {
    const close = text.indexOf("'", start + 1);
    if (close < 0) return null;
    const body = text.slice(start + 1, close);
    return body.includes("\n") ? null : body;
  }
  return null;
}

/** The index of `quote` closing a basic string that starts at `from`, stepping over escapes. */
function closingOf(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text.startsWith(quote, i)) {
      // `""""` ends a multi-line string with a quote inside it: the closing three are the last three.
      let end = i;
      while (quote.length === 3 && text[end + 3] === '"' && end - i < 2) end++;
      return end;
    }
  }
  return -1;
}

function trimFirstNewline(s: string): string {
  return s.startsWith("\r\n") ? s.slice(2) : s.startsWith("\n") ? s.slice(1) : s;
}

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

function unescapeBasic(s: string, multiline: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[i + 1] ?? "";
    if (n in ESCAPES) {
      out += ESCAPES[n];
      i++;
    } else if (n === "u" || n === "U") {
      const len = n === "u" ? 4 : 8;
      const hex = s.slice(i + 2, i + 2 + len);
      const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === len ? Number.parseInt(hex, 16) : NaN;
      out += Number.isNaN(code) ? "" : String.fromCodePoint(code);
      i += 1 + len;
    } else if (multiline && /[ \t\r\n]/.test(n)) {
      // A backslash at the end of a line joins it to the next, without the white space between.
      let j = i + 1;
      while (j < s.length && /[ \t\r\n]/.test(s[j]!)) j++;
      i = j - 1;
    } else {
      out += n;
      i++;
    }
  }
  return out;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
