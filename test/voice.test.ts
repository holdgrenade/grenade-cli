import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceFrame } from "@grenade/protocol";
import { statusLines } from "../src/cli/voiceCommand.js";
import type { Logger } from "../src/log.js";
import { gemini } from "../src/voice/gemini.js";
import { mintToken } from "../src/voice/mintToken.js";
import { openai } from "../src/voice/openai.js";
import { VOICE_PROVIDERS, voiceProvider } from "../src/voice/voiceCatalog.js";
import { cleanVoiceKey, maskVoiceKey, withoutKey } from "../src/voice/voiceKey.js";
import { loadVoiceKeys, saveVoiceKeys } from "../src/voice/voiceKeyStore.js";
import { refusalWords, VoiceError, type TokenAsk } from "../src/voice/voiceProvider.js";
import { VoiceService } from "../src/voice/voiceService.js";

const now = new Date("2026-10-04T12:00:00.000Z");
const ask = (use: string, model?: string): TokenAsk => ({ use, model, daemonId: "d_9f8e7d", now });
const KEY = "sk-proj-0123456789abcdefghijklmnopqrstuvwxyzABCD";

/** A provider's HTTP side: answers every request with `status` and `body`, and remembers what it was asked. */
function fakeFetch(answer: (url: string) => { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const { status, body } = answer(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Everything a logger was given, as one text. */
function recordingLogger() {
  const lines: string[] = [];
  const write = (m: string, d?: unknown) => lines.push(`${m} ${JSON.stringify(d ?? {})}`);
  const log: Logger = { debug: write, info: write, warn: write, error: write, close() {} };
  return { log, text: () => lines.join("\n") };
}

describe("a pasted key", () => {
  it("is trimmed, loses a Bearer in front, and is nothing when it could not be a key", () => {
    expect(cleanVoiceKey(`  ${KEY}\n`)).toBe(KEY);
    expect(cleanVoiceKey(`Bearer ${KEY}`)).toBe(KEY);
    expect(cleanVoiceKey("bearer")).toBeNull();
    expect(cleanVoiceKey("   ")).toBeNull();
    expect(cleanVoiceKey("two words")).toBeNull();
    expect(cleanVoiceKey("k".repeat(401))).toBeNull();
  });

  it("is masked to what tells which one it is", () => {
    expect(maskVoiceKey(KEY)).toBe("sk-…ABCD");
    expect(maskVoiceKey("short")).toBe("…");
  });

  it("is taken out of a provider's words", () => {
    expect(withoutKey(`Incorrect API key provided: ${KEY}.`, KEY)).toBe("Incorrect API key provided: <key>.");
  });
});

describe("the providers", () => {
  it("have ids of their own, and each a use", () => {
    expect(VOICE_PROVIDERS.map((p) => p.id)).toEqual(["openai", "gemini"]);
    expect(new Set(VOICE_PROVIDERS.map((p) => p.id)).size).toBe(VOICE_PROVIDERS.length);
    for (const p of VOICE_PROVIDERS) expect(p.uses.length, p.id).toBeGreaterThan(0);
    expect(voiceProvider("gemini")).toBe(gemini);
    expect(voiceProvider("wispr-flow")).toBeUndefined();
    expect(voiceProvider("nobody")).toBeUndefined();
    // What `voice` carries decodes, with and without a key.
    const service = new VoiceService({ daemonId: "d_1", log: recordingLogger().log });
    expect(VoiceFrame.safeParse(service.frame()).success).toBe(true);
  });

  it("OpenAI: a client secret, for the model when one is named, used once", () => {
    const request = openai.tokenRequest(KEY, ask("talk", "gpt-realtime-2.1-mini"));
    expect(request).toEqual({
      url: "https://api.openai.com/v1/realtime/client_secrets",
      headers: { Authorization: `Bearer ${KEY}` },
      body: { expires_after: { anchor: "created_at", seconds: 60 }, session: { type: "realtime", model: "gpt-realtime-2.1-mini" } },
    });
    expect(openai.tokenRequest(KEY, ask("talk")).body).toEqual({ expires_after: { anchor: "created_at", seconds: 60 } });
    expect(openai.readToken({ value: "ek_1", expires_at: 1791115260, session: {} }, ask("talk"))).toEqual({ token: "ek_1", expiresAt: new Date(1791115260000), once: true });
    expect(openai.readToken({ value: "ek_1" }, ask("talk"))?.expiresAt).toEqual(new Date("2026-10-04T12:01:00.000Z"));
    expect(openai.readToken({ error: {} }, ask("talk"))).toBeNull();
  });

  it("Gemini: an ephemeral token, the key in a header and never in the URL, a minute to start one session", () => {
    const request = gemini.tokenRequest(KEY, ask("talk"));
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect(request.url).not.toContain(KEY);
    expect(request.headers).toEqual({ "x-goog-api-key": KEY });
    expect(request.body).toEqual({ uses: 1, newSessionExpireTime: "2026-10-04T12:01:00.000Z", expireTime: "2026-10-04T12:30:00.000Z" });
    expect(gemini.readToken({ name: "auth_tokens/abc" }, ask("talk"))).toEqual({ token: "auth_tokens/abc", expiresAt: new Date("2026-10-04T12:01:00.000Z"), once: true });
    expect(gemini.readToken({}, ask("talk"))).toBeNull();
  });

  it("a refusal is read in the shapes providers use", () => {
    expect(refusalWords({ error: { message: "Incorrect API key provided." } })).toBe("Incorrect API key provided.");
    expect(refusalWords({ error: "Token has expired" })).toBe("Token has expired");
    expect(refusalWords({ detail: "Unauthorized" })).toBe("Unauthorized");
    expect(refusalWords({ message: "no" })).toBe("no");
    expect(refusalWords(null)).toBeUndefined();
    expect(refusalWords({ error: { code: 401 } })).toBeUndefined();
  });
});

describe("mintToken", () => {
  it("posts the provider's request as JSON and reads its token", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { value: "ek_1", expires_at: 1791115260 } }));
    const minted = await mintToken(openai, KEY, ask("talk", "gpt-realtime-2.1"), { fetch });
    expect(minted.token).toBe("ek_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(calls[0]!.body).toMatchObject({ session: { model: "gpt-realtime-2.1" } });
  });

  it("says the provider's own words when it refuses, never the key", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}.` } } }));
    const failure = await mintToken(openai, KEY, ask("talk"), { fetch }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(VoiceError);
    expect((failure as VoiceError).code).toBe("provider_failed");
    expect((failure as VoiceError).message).toBe("Incorrect API key provided: <key>.");
  });

  it("says who did not answer, who answered without words, and who sent no token", async () => {
    const down = (async () => { throw new Error(`connect failed with Authorization: Bearer ${KEY}`); }) as unknown as typeof fetch;
    expect(await mintToken(gemini, KEY, ask("talk"), { fetch: down }).catch((e: Error) => e.message)).toBe("Google did not answer.");
    expect(await mintToken(gemini, KEY, ask("talk"), { fetch: fakeFetch(() => ({ status: 500, body: null })).fetch }).catch((e: Error) => e.message)).toBe("Google answered 500.");
    expect(await mintToken(openai, KEY, ask("talk"), { fetch: fakeFetch(() => ({ status: 200, body: {} })).fetch }).catch((e: Error) => e.message)).toBe("OpenAI sent no token.");
  });
});

describe("voice-keys.json", () => {
  it("is readable by its owner only, also one that was open before, and a broken one reads as no keys", () => {
    const path = join(mkdtempSync(join(tmpdir(), "grenade-voice-")), "voice-keys.json");
    expect(loadVoiceKeys(path)).toEqual({});
    saveVoiceKeys(path, { openai: KEY });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadVoiceKeys(path)).toEqual({ openai: KEY });
    const open = join(mkdtempSync(join(tmpdir(), "grenade-voice-")), "voice-keys.json");
    writeFileSync(open, "{}", { mode: 0o644 });
    saveVoiceKeys(open, { openai: KEY });
    expect(statSync(open).mode & 0o777).toBe(0o600);
    writeFileSync(path, "not json");
    expect(loadVoiceKeys(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ openai: 7, gemini: "", other: "o-1" }));
    expect(loadVoiceKeys(path)).toEqual({ other: "o-1" });
  });
});

describe("VoiceService", () => {
  const good = () => fakeFetch((url) => (url.includes("openai") ? { status: 200, body: { value: "ek_1", expires_at: 1791115260 } } : { status: 401, body: { error: { message: "API key not valid." } } }));

  it("keeps a key only once its provider made a token with it, and tells who listens", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "grenade-voice-")), "voice-keys.json");
    const { fetch, calls } = good();
    const { log, text } = recordingLogger();
    const service = new VoiceService({ path, daemonId: "d_1", log, fetch, now: () => now });
    const heard: unknown[] = [];
    service.on("changed", (f) => heard.push(f));
    expect(service.list()).toEqual([
      { id: "openai", name: "OpenAI", uses: ["talk"] },
      { id: "gemini", name: "Google", uses: ["talk"] },
    ]);
    expect(await service.setKey("openai", ` Bearer ${KEY} `)).toBe(true);
    // The check asks for no model: a key that may use one may use the others.
    expect(calls[0]!.body).toEqual({ expires_after: { anchor: "created_at", seconds: 60 } });
    expect(service.list()[0]).toEqual({ id: "openai", name: "OpenAI", uses: ["talk"], key: "sk-…ABCD" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ openai: KEY });
    expect(heard).toEqual([service.frame()]);
    // The same key again: checked, nothing changed.
    expect(await service.setKey("openai", KEY)).toBe(false);
    expect(heard).toHaveLength(1);
    // A key the provider refuses is not kept, and what was kept before stays.
    await expect(service.setKey("gemini", "AIza-made-up-key-000")).rejects.toMatchObject({ code: "provider_failed", message: "API key not valid." });
    expect(service.list()[1]).not.toHaveProperty("key");
    await expect(service.setKey("openai", "two words")).rejects.toMatchObject({ code: "bad_frame" });
    await expect(service.setKey("nobody", "k")).rejects.toMatchObject({ code: "bad_frame" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ openai: KEY });
    // Nothing that was logged holds a key or a token.
    expect(text()).toContain("Kept the OpenAI key");
    expect(text()).not.toContain(KEY);
    expect(text()).not.toContain("ek_1");
  });

  it("makes a token for a use the provider has and a key it holds", async () => {
    const { fetch, calls } = good();
    const service = new VoiceService({ daemonId: "d_1", log: recordingLogger().log, fetch, now: () => now });
    await expect(service.token("openai", "talk", undefined)).rejects.toMatchObject({ code: "bad_frame", message: expect.stringContaining("No OpenAI API key") });
    await service.setKey("openai", KEY);
    await expect(service.token("openai", "dictation", undefined)).rejects.toMatchObject({ code: "bad_frame" });
    await expect(service.token("nobody", "talk", undefined)).rejects.toMatchObject({ code: "bad_frame" });
    expect(await service.token("openai", "talk", "gpt-realtime-2.1-mini")).toEqual({ token: "ek_1", expiresAt: new Date(1791115260000), once: true });
    expect(calls.at(-1)!.body).toMatchObject({ session: { type: "realtime", model: "gpt-realtime-2.1-mini" } });
  });

  it("forgets a key, and reads the file again when `grenade voice` wrote it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "grenade-voice-")), "voice-keys.json");
    const service = new VoiceService({ path, daemonId: "d_1", log: recordingLogger().log, fetch: good().fetch });
    const heard: unknown[] = [];
    service.on("changed", (f) => heard.push(f));
    expect(await service.setKey("openai", null)).toBe(false);
    saveVoiceKeys(path, { gemini: "AIza0123456789abcdef" });
    expect(service.reload()[1]).toMatchObject({ id: "gemini", key: "AIz…cdef" });
    expect(heard).toHaveLength(1);
    // Read again with nothing new: nobody is told.
    service.reload();
    expect(heard).toHaveLength(1);
    expect(await service.setKey("gemini", null)).toBe(true);
    expect(loadVoiceKeys(path)).toEqual({});
    expect(heard).toHaveLength(2);
  });
});

describe("a provider that is gone", () => {
  it("drops its kept key, from the file too (Wispr Flow's, after it closed its API)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "grenade-voice-")), "voice-keys.json");
    saveVoiceKeys(path, { openai: KEY, "wispr-flow": "fl-0123456789abcdef" });
    const service = new VoiceService({ path, daemonId: "d_1", log: recordingLogger().log });
    expect(service.list().map((p) => p.id)).toEqual(["openai", "gemini"]);
    expect(loadVoiceKeys(path)).toEqual({ openai: KEY });
    saveVoiceKeys(path, { openai: KEY, "wispr-flow": "fl-0123456789abcdef" });
    service.reload();
    expect(loadVoiceKeys(path)).toEqual({ openai: KEY });
  });
});

describe("grenade voice", () => {
  it("lists every provider with what it is for and whether a key is kept", () => {
    expect(statusLines(VOICE_PROVIDERS, { openai: KEY })).toEqual([
      "openai  OpenAI · Talk · key sk-…ABCD",
      "gemini  Google · Talk · no key",
      "",
      "Keep a key with: grenade voice key <provider>",
    ]);
  });
});
