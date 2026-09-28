import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DEFAULT_PROTECTED_NAMES = [".env.keys"];
export const DEFAULT_PROTECTED_DIRS = ["~/.dotenvx", "~/.dotenvx/.env.keys"];

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function canonicalize(input: string): string {
  const expanded = expandHome(input);
  const absolute = path.resolve(expanded);
  try {
    return realpathSync(absolute);
  } catch {
    const missingSuffix: string[] = [];
    let ancestor = absolute;
    while (true) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.normalize(absolute);
      missingSuffix.unshift(path.basename(ancestor));
      ancestor = parent;
      try {
        return path.join(realpathSync(ancestor), ...missingSuffix);
      } catch {
        // Keep walking until an existing ancestor can be canonicalized.
      }
    }
  }
}

/** True if path names a protected file or is within a protected directory. */
export function isProtectedPath(
  rawPath: string,
  cwd: string,
  protectedNames: string[] = DEFAULT_PROTECTED_NAMES,
  protectedDirs: string[] = DEFAULT_PROTECTED_DIRS,
): boolean {
  if (!rawPath) return false;
  const lexicalPath = path.resolve(cwd, expandHome(rawPath));
  const actualPath = canonicalize(lexicalPath);
  const candidates = new Set([path.normalize(lexicalPath), actualPath]);

  for (const candidate of candidates) {
    if (protectedNames.includes(path.basename(candidate))) return true;
  }

  for (const protectedDir of protectedDirs) {
    const protectedPath = canonicalize(path.resolve(cwd, expandHome(protectedDir)));
    for (const candidate of candidates) {
      const relative = path.relative(protectedPath, candidate);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Exact commands the model is invited to run against .env.keys. Their output
 * carries no secret values (redaction scrubs them), so they are always safe.
 * Exact match only: any extra argument stays subject to the bash gate.
 */
export function isSanctionedCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "cat .env.keys" || trimmed === "ls .env.keys";
}

function tokenAsGlobMatches(token: string, name: string): boolean {
  if (!/[?*]/.test(token)) return false;
  const pattern = token
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${pattern}$`).test(name);
  } catch {
    return false;
  }
}

/** Advisory-only shell scan; not a substitute for OS-level sandboxing. */
export function bashReferencesProtected(command: string, protectedNames: string[] = DEFAULT_PROTECTED_NAMES): boolean {
  const tokens = command.split(/[\s;'\"`|$()&<>]/).filter(Boolean);
  return (
    protectedNames.some(
      (name) =>
        command.includes(name) ||
        command.includes(name.replaceAll(".", "?")) ||
        tokens.some((token) => tokenAsGlobMatches(token, name)),
    ) || /\.env(?:\*|\?)[^\s/]*keys|\.env\.[^\s/]*\.keys/i.test(command)
  );
}

const KEY_TOKEN = /key_[A-Za-z0-9+/=]{40,}/g;
const PRIVATE_KEY_VALUE = /(^[ \t]*DOTENV_PRIVATE_KEY_[A-Z0-9_]+[ \t]*=[ \t]*)(\S[^\r\n]*)/gim;

/**
 * Remove recognizable dotenvx secrets from text returned by tools. This is the
 * mechanism that makes `cat .env.keys` safe: key names survive, values do not.
 */
export function redactSecrets(text: string): string {
  return text.replace(KEY_TOKEN, "[redacted]").replace(PRIVATE_KEY_VALUE, "$1[redacted]");
}

/**
 * Single telltale sign: the dotenvx private-key file at the repo root.
 * The guard silently no-ops in any project without it. Re-checked each
 * turn (one stat) so a repo gaining .env.keys mid-session wakes the guard.
 */
export async function detectDotenvxUsage(cwd: string): Promise<boolean> {
  try {
    return (await stat(path.resolve(cwd, ".env.keys"))).isFile();
  } catch {
    return false;
  }
}
