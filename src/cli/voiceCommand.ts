/**
 * `grenade voice | voice key <provider> | voice forget <provider>`: the owner's API keys for Talk (speech to speech)
 * and dictation (speech to text), kept on this computer only (PROTOCOL.md "Voice providers"). The command checks a key
 * with its provider and writes voice-keys.json itself, then tells a running daemon to read it again, so it works
 * with the daemon stopped too.
 */
import type { Command } from "commander";
import { VOICE_USE_DICTATION, VOICE_USE_TALK } from "@grenade/protocol";
import { loadDaemonId, paths } from "../config.js";
import { computerWord } from "../platform/computer.js";
import { mintToken } from "../voice/mintToken.js";
import { VOICE_PROVIDERS, voiceProvider } from "../voice/voiceCatalog.js";
import { cleanVoiceKey, maskVoiceKey } from "../voice/voiceKey.js";
import { loadVoiceKeys, saveVoiceKeys, type VoiceKeys } from "../voice/voiceKeyStore.js";
import type { VoiceProvider } from "../voice/voiceProvider.js";
import type { Control } from "./controlClient.js";
import { readSecret } from "./readSecret.js";

export interface VoiceCommandDeps {
  control: Control;
}

export function registerVoiceCommand(program: Command, d: VoiceCommandDeps): void {
  const voice = program
    .command("voice")
    .description(`your API keys for Talk, kept on this ${computerWord()} and never on a phone`)
    .action(() => {
      for (const line of statusLines(VOICE_PROVIDERS, loadVoiceKeys(paths.voiceKeys))) console.log(line);
    });

  voice
    .command("key <provider>")
    .description(`keep your API key for a provider (${ids()}); it is asked for, or read from stdin, and checked with the provider first`)
    .action(async (id: string) => {
      const provider = known(id);
      const key = cleanVoiceKey(await readSecret(`Paste your ${provider.name} API key (it is not shown): `));
      if (!key) throw new Error("that does not look like an API key");
      // A token is what the key is for: a provider that makes one has taken the key. It bills nothing.
      await mintToken(provider, key, { use: provider.uses[0]!, daemonId: loadDaemonId(), now: new Date() });
      saveVoiceKeys(paths.voiceKeys, { ...loadVoiceKeys(paths.voiceKeys), [provider.id]: key });
      console.log(`${provider.name} took the key (${maskVoiceKey(key)}). It is kept on this ${computerWord()}; your phone asks it for a short-lived token each time.`);
      await reload(d.control);
    });

  voice
    .command("forget <provider>")
    .description("forget a provider's API key")
    .action(async (id: string) => {
      const provider = known(id);
      const { [provider.id]: gone, ...rest } = loadVoiceKeys(paths.voiceKeys);
      if (gone === undefined) return console.log(`no ${provider.name} key is kept`);
      saveVoiceKeys(paths.voiceKeys, rest);
      console.log(`forgot the ${provider.name} key. To make the key itself worthless, revoke it at ${provider.name}.`);
      await reload(d.control);
    });
}

/** One line per provider, then how to keep a key. Pure. */
export function statusLines(providers: VoiceProvider[], keys: VoiceKeys): string[] {
  const width = Math.max(...providers.map((p) => p.id.length));
  const lines = providers.map((p) => {
    const key = keys[p.id];
    return `${p.id.padEnd(width)}  ${p.name} · ${p.uses.map(useWord).join(", ")} · ${key ? `key ${maskVoiceKey(key)}` : "no key"}`;
  });
  return [...lines, "", "Keep a key with: grenade voice key <provider>"];
}

function useWord(use: string): string {
  if (use === VOICE_USE_TALK) return "Talk";
  if (use === VOICE_USE_DICTATION) return "dictation";
  return use;
}

function ids(): string {
  return VOICE_PROVIDERS.map((p) => p.id).join(", ");
}

function known(id: string): VoiceProvider {
  const provider = voiceProvider(id.toLowerCase());
  if (!provider) throw new Error(`no voice provider "${id}". There are: ${ids()}`);
  return provider;
}

async function reload(control: Control): Promise<void> {
  const told = await control("POST", "/voice/reload").then(() => true).catch(() => false);
  if (!told) console.log("(grenaded is not running; it reads the key on its next start)");
}
