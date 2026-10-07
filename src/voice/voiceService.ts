/**
 * The daemon's side of PROTOCOL.md "Voice providers": which providers there are and which hold a key, keeping or
 * forgetting a key (checked with its provider first), and a short-lived token for a client. Emits `changed` with the
 * `voice` frame whenever a key is kept or forgotten. A key or a token never reaches a log line.
 */
import { EventEmitter } from "node:events";
import type { VoiceFrame, VoiceProviderInfo } from "@grenade/protocol";
import type { Logger } from "../log.js";
import { computerWord } from "../platform/computer.js";
import { mintToken, type Fetch } from "./mintToken.js";
import { VOICE_PROVIDERS } from "./voiceCatalog.js";
import { cleanVoiceKey, maskVoiceKey } from "./voiceKey.js";
import { loadVoiceKeys, saveVoiceKeys, type VoiceKeys } from "./voiceKeyStore.js";
import { VoiceError, type MintedToken, type VoiceProvider } from "./voiceProvider.js";

export interface VoiceServiceOptions {
  /** voice-keys.json. Absent: the keys live in memory only (tests). */
  path?: string | undefined;
  daemonId: string;
  log: Logger;
  providers?: VoiceProvider[];
  fetch?: Fetch;
  now?: () => Date;
}

export class VoiceService extends EventEmitter {
  private keys: VoiceKeys;
  private readonly providers: VoiceProvider[];

  constructor(private readonly o: VoiceServiceOptions) {
    super();
    this.providers = o.providers ?? VOICE_PROVIDERS;
    this.keys = o.path ? this.known(loadVoiceKeys(o.path)) : {};
  }

  list(): VoiceProviderInfo[] {
    return this.providers.map((p) => {
      const key = this.keys[p.id];
      return { id: p.id, name: p.name, uses: [...p.uses], ...(key ? { key: maskVoiceKey(key) } : {}) };
    });
  }

  frame(): VoiceFrame {
    return { type: "voice", providers: this.list() };
  }

  /** Keeps the key once its provider has taken it; null forgets it. Resolves with whether anything changed. */
  async setKey(providerId: string, pasted: string | null): Promise<boolean> {
    const provider = this.provider(providerId);
    if (pasted === null) {
      if (!(provider.id in this.keys)) return false;
      const { [provider.id]: _gone, ...rest } = this.keys;
      this.keep(rest);
      this.o.log.info(`Forgot the ${provider.name} key`, { provider: provider.id });
      return true;
    }
    const key = cleanVoiceKey(pasted);
    if (!key) throw new VoiceError("bad_frame", "That does not look like an API key.");
    // A token is what the key is for: a provider that makes one has taken the key. It bills nothing.
    await mintToken(provider, key, this.ask(provider.uses[0]!, undefined), this.io());
    if (this.keys[provider.id] === key) return false;
    this.keep({ ...this.keys, [provider.id]: key });
    this.o.log.info(`Kept the ${provider.name} key`, { provider: provider.id });
    return true;
  }

  async token(providerId: string, use: string, model: string | undefined): Promise<MintedToken> {
    const provider = this.provider(providerId);
    if (!provider.uses.includes(use)) throw new VoiceError("bad_frame", `${provider.name} is not used for ${use}.`);
    const key = this.keys[provider.id];
    if (!key) throw new VoiceError("bad_frame", `No ${provider.name} API key is kept on this ${computerWord()}.`);
    return mintToken(provider, key, this.ask(use, model), this.io());
  }

  /** `grenade voice` wrote voice-keys.json: read it again and tell the clients. */
  reload(): VoiceProviderInfo[] {
    if (this.o.path) {
      const next = this.known(loadVoiceKeys(this.o.path));
      const changed = JSON.stringify(next) !== JSON.stringify(this.keys);
      this.keys = next;
      if (changed) this.emit("changed", this.frame());
    }
    return this.list();
  }

  private keep(keys: VoiceKeys): void {
    this.keys = keys;
    if (this.o.path) saveVoiceKeys(this.o.path, keys);
    this.emit("changed", this.frame());
  }

  /** The keys of providers this daemon has. A key of one it no longer has (Wispr Flow's) is dropped from the file too. */
  private known(keys: VoiceKeys): VoiceKeys {
    const kept = Object.fromEntries(Object.entries(keys).filter(([id]) => this.providers.some((p) => p.id === id)));
    if (this.o.path && Object.keys(kept).length !== Object.keys(keys).length) saveVoiceKeys(this.o.path, kept);
    return kept;
  }

  private provider(id: string): VoiceProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new VoiceError("bad_frame", `This ${computerWord()} has no voice provider "${id}".`);
    return provider;
  }

  private ask(use: string, model: string | undefined) {
    return { use, model, daemonId: this.o.daemonId, now: (this.o.now ?? (() => new Date()))() };
  }

  private io(): { fetch?: Fetch } {
    return this.o.fetch ? { fetch: this.o.fetch } : {};
  }
}
