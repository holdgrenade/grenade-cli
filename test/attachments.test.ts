import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentFileName, extensionFor } from "../src/attachments/attachmentName.js";
import { createAttachmentStore } from "../src/attachments/attachmentStore.js";

const at = new Date("2026-09-28T10:15:00.000Z");

describe("attachmentFileName", () => {
  it("prefixes a UTC stamp and takes the extension from the mime type", () => {
    expect(attachmentFileName("screenshot.png", "image/png", at)).toBe("20260928-101500-screenshot.png");
    expect(attachmentFileName("IMG_0042.HEIC", "image/jpeg", at)).toBe("20260928-101500-IMG_0042.jpg");
  });

  it("keeps the name's own extension for types it does not know", () => {
    expect(attachmentFileName("notes.txt", "text/plain", at)).toBe("20260928-101500-notes.txt");
    expect(attachmentFileName("blob", "application/octet-stream", at)).toBe("20260928-101500-blob");
  });

  it("drops path parts and anything but letters, digits, dots, dashes and underscores", () => {
    expect(attachmentFileName("../../etc/passwd", "text/plain", at)).toBe("20260928-101500-passwd");
    expect(attachmentFileName("my shot (1)!.png", "image/png", at)).toBe("20260928-101500-my-shot-1.png");
    expect(attachmentFileName(".hidden", "image/png", at)).toBe("20260928-101500-hidden.png");
    expect(attachmentFileName("***", "image/png", at)).toBe("20260928-101500-file.png");
    expect(attachmentFileName("a".repeat(100) + ".png", "image/png", at)).toBe(`20260928-101500-${"a".repeat(60)}.png`);
  });

  it("maps the image types the phone sends", () => {
    expect(extensionFor("image/jpeg; charset=binary")).toBe(".jpg");
    expect(extensionFor("IMAGE/WEBP")).toBe(".webp");
    expect(extensionFor("text/plain")).toBeNull();
  });
});

describe("attachmentStore", () => {
  it("writes under <dir>/<session>/ and never overwrites", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-att-"));
    const store = createAttachmentStore(dir, () => at);
    const first = await store.save("gr-app", "shot.png", "image/png", Buffer.from("one"));
    const second = await store.save("gr-app", "shot.png", "image/png", Buffer.from("two"));
    expect(first).toEqual({ path: join(dir, "gr-app", "20260928-101500-shot.png"), bytes: 3 });
    expect(second.path).toBe(join(dir, "gr-app", "20260928-101500-shot-2.png"));
    expect(readFileSync(first.path, "utf8")).toBe("one");
    expect(readFileSync(second.path, "utf8")).toBe("two");
  });

  it("gives uploads written at once, under the same name, a file each", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenade-att-"));
    const store = createAttachmentStore(dir, () => at);
    const saved = await Promise.all(["a", "b", "c"].map((body) => store.save("gr-app", "image", "image/png", Buffer.from(body))));
    expect(new Set(saved.map((s) => s.path)).size).toBe(3);
    expect(saved.map((s) => readFileSync(s.path, "utf8")).sort()).toEqual(["a", "b", "c"]);
  });
});
