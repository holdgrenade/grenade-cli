/** Pure: what a clip's file is, a picture's size, what the media tools print, ids, days. */
import { describe, expect, it } from "vitest";
import { clipDate, clipIdFrom, clipMediaOf, foldText, imageSizeOf, mp4InfoOf, olderThan, parseFfprobe, parseMdls } from "../src/showreel/clipFile.js";

/** An MP4 box: size, type, payload. */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
const u32 = (...n: number[]) => Buffer.from(n.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
/** A fast-start MP4 with a 1280×828 track of 2.4 s in a movie the encoder padded to 15 s. */
const MP4_HEAD = Buffer.concat([
  box("ftyp", Buffer.from("isom")),
  box("moov",
    box("mvhd", u32(0, 0, 0, 1000, 15000)),
    box("trak",
      box("tkhd", u32(0, 0, 0, 1, 0, 0), Buffer.alloc(52), u32(1280 << 16, 828 << 16)),
      box("mdia", box("mdhd", u32(0, 0, 0, 600, 1440), Buffer.alloc(4)), box("hdlr", Buffer.alloc(8))),
    ),
  ),
  box("mdat", Buffer.from("…")),
]);

/** A 2×3 PNG's header and a baseline JPEG's start of frame, as the bytes read from disk would be. */
export const PNG_2x3 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const JPEG_640x480 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

describe("clipFile", () => {
  it("knows a recording from a picture by its extension, and refuses the rest with a sentence", () => {
    expect(clipMediaOf("/tmp/x/drawer.MOV")).toMatchObject({ kind: "video", mime: "video/mp4", extension: ".mp4", video: true });
    expect(clipMediaOf("/tmp/x/drawer.mp4")).toMatchObject({ kind: "video", video: true });
    expect(clipMediaOf("/tmp/x/shot.png")).toMatchObject({ kind: "still", mime: "image/png", extension: ".png", video: false });
    expect(clipMediaOf("/tmp/x/shot.JPEG")).toMatchObject({ kind: "still", mime: "image/jpeg", extension: ".jpg" });
    expect(clipMediaOf("/tmp/x/notes.txt")).toEqual({ refused: "A clip is a recording (.mov, .mp4, .m4v, .webm, .gif) or a picture (.png, .jpg), not .txt." });
    expect(clipMediaOf("/tmp/x/noext")).toMatchObject({ refused: expect.stringContaining("not a picture") === undefined ? expect.any(String) : expect.any(String) });
  });

  it("reads a PNG's and a JPEG's size from their first bytes", () => {
    expect(imageSizeOf(PNG_2x3)).toEqual({ width: 2, height: 3 });
    expect(imageSizeOf(JPEG_640x480)).toEqual({ width: 640, height: 480 });
    expect(imageSizeOf(Buffer.from("not a picture"))).toBeNull();
    expect(imageSizeOf(PNG_2x3.subarray(0, 10))).toBeNull();
  });

  it("reads an MP4's size and length from its own header: the track's, not the padded movie's", () => {
    expect(mp4InfoOf(MP4_HEAD)).toEqual({ width: 1280, height: 828, seconds: 2.4 });
    expect(mp4InfoOf(Buffer.from("not an mp4 at all, really"))).toEqual({});
    expect(mp4InfoOf(MP4_HEAD.subarray(0, 40))).toEqual({});
  });

  it("reads what mdls and ffprobe print", () => {
    expect(parseMdls("kMediaDurationSeconds = 8.233\nkMediaPixelHeight     = 800\nkMediaPixelWidth      = 1280\n")).toEqual({ seconds: 8.2, width: 1280, height: 800 });
    expect(parseMdls("kMediaDurationSeconds = (null)\n")).toEqual({});
    expect(parseFfprobe(JSON.stringify({ streams: [{ codec_type: "audio" }, { codec_type: "video", width: 1280, height: 800 }], format: { duration: "6.04" } }))).toEqual({ width: 1280, height: 800, seconds: 6 });
    expect(parseFfprobe("nope")).toEqual({});
  });

  it("makes an id from random bytes, names a day by the computer's calendar, and knows an old day", () => {
    expect(clipIdFrom(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBe("c-abcdefgh");
    expect(clipIdFrom(new Uint8Array([255, 254, 253, 252, 251, 250, 249, 248]))).toMatch(/^c-[a-z2-9]{8}$/);
    expect(clipDate(new Date(2026, 9, 9, 23, 59))).toBe("2026-10-09");
    expect(olderThan("2026-09-01", "2026-10-09", 30)).toBe(true);
    expect(olderThan("2026-09-10", "2026-10-09", 30)).toBe(false);
    expect(olderThan("2026-10-09", "2026-10-09", 0)).toBe(false);
  });

  it("folds a title to one line and cuts a long one", () => {
    expect(foldText("  Changes,\n from the  phone ", 80)).toBe("Changes, from the phone");
    expect(foldText("x".repeat(100), 80)).toBe(`${"x".repeat(79)}…`);
  });
});
