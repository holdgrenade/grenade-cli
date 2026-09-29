/** Pure: the file name an uploaded attachment gets on disk (PROTOCOL.md "Attachments"). No I/O, no clock. */

const EXTENSION_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

/** The extension a media type maps to, or null for types the daemon does not name itself. */
export function extensionFor(mime: string): string | null {
  return EXTENSION_FOR_MIME[mime.toLowerCase().split(";")[0]!.trim()] ?? null;
}

/**
 * `<UTC yyyyMMdd-HHmmss>-<safe name>`: the name reduced to letters, digits, dots, dashes and underscores (any path
 * part dropped), cut to 60 characters, with the extension that matches `mime` when the daemon knows one.
 */
export function attachmentFileName(name: string, mime: string, now: Date): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stemRaw = dot > 0 ? base.slice(0, dot) : base;
  const extRaw = dot > 0 ? base.slice(dot) : "";
  const stem = clean(stemRaw).slice(0, 60) || "file";
  const ext = extensionFor(mime) ?? (extRaw ? "." + clean(extRaw.slice(1)).slice(0, 10) : "");
  return `${stamp(now)}-${stem}${ext === "." ? "" : ext}`;
}

function clean(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
