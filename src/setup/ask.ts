/** Asks a yes/no question on the terminal. `assumeYes` (--yes) and a stdin that is not a terminal answer by themselves. */
import { createInterface } from "node:readline/promises";
import { readYesNo } from "./answer.js";

export interface AskOptions {
  defaultYes: boolean;
  /** `--yes`: take the default without asking. */
  assumeYes: boolean;
  /** Answer when nobody can be asked (stdin is not a terminal) and `--yes` was not given. */
  unattended: boolean;
}

export async function askYesNo(question: string, o: AskOptions): Promise<boolean> {
  if (o.assumeYes) return o.defaultYes;
  if (!process.stdin.isTTY) return o.unattended;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = readYesNo(await rl.question(`${question} ${o.defaultYes ? "[Y/n]" : "[y/N]"} `), o.defaultYes);
      if (answer !== null) return answer;
    }
  } finally {
    rl.close();
  }
}
