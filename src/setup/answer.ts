/** Reads a typed answer to a yes/no question. Pure. Empty means the default; anything unclear is null (ask again). */
export function readYesNo(answer: string, defaultYes: boolean): boolean | null {
  const a = answer.trim().toLowerCase();
  if (a === "") return defaultYes;
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return null;
}
