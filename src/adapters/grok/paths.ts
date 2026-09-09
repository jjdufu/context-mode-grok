import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Resolve Grok Build config root.
 * Honors $GROK_HOME (documented in Grok user guide) with tilde expansion.
 */
export function resolveGrokConfigDir(): string {
  const envVal = process.env.GROK_HOME;
  if (envVal) {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".grok");
}
