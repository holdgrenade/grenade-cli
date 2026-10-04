/** Reads a secret from the terminal without showing it, or from stdin when it is piped. Never from an argument, which the shell would keep in its history. */

export async function readSecret(prompt: string, io: { stdin?: NodeJS.ReadStream; stderr?: NodeJS.WriteStream } = {}): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  const stderr = io.stderr ?? process.stderr;
  if (!stdin.isTTY) {
    let piped = "";
    for await (const chunk of stdin) piped += String(chunk);
    return piped.split(/\r?\n/)[0] ?? "";
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let typed = "";
    const done = (finish: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      finish();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(typed));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else if (ch >= " ") typed += ch;
      }
    };
    stdin.on("data", onData);
  });
}
