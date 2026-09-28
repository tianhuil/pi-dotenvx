import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DEFAULT_PROTECTED_NAMES = [".env.keys"];
export const DEFAULT_PROTECTED_DIRS = ["~/.dotenvx", "~/.dotenvx/.env.keys"];

export interface SafeEnvironmentFile {
  name: string;
  appEnv?: string;
  hasEncryptedEntries: boolean;
}

export interface PrivateKeyMetadata {
  name: string;
  size: number;
  modifiedAt: string;
  count: number;
  entryNames: string[];
}

export interface SafeInfo {
  cwd: string;
  environments: SafeEnvironmentFile[];
  privateKeysFile?: PrivateKeyMetadata;
  dotenvxHomeKeysExists: boolean;
}

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
  const tokens = command.split(/[\s;'"`|$()&<>]/).filter(Boolean);
  return (
    protectedNames.some(
      (name) =>
        command.includes(name) ||
        command.includes(name.replaceAll(".", "?")) ||
        tokens.some((token) => tokenAsGlobMatches(token, name)),
    ) || /\.env(?:\*|\?)[^\s/]*keys|\.env\.[^\s/]*\.keys/i.test(command)
  );
}

const PRIVATE_KEY_LINE = /^\s*(DOTENV_PRIVATE_KEY_[A-Z0-9_]+)\s*=\s*(.*)$/i;
const KEY_TOKEN = /key_[A-Za-z0-9+/=]{40,}/g;
const PRIVATE_KEY_VALUE = /(^[ \t]*DOTENV_PRIVATE_KEY_[A-Z0-9_]+[ \t]*=[ \t]*)(\S[^\r\n]*)/gim;

/** Remove recognizable dotenvx secrets from text returned by tools. */
export function redactSecrets(text: string): string {
  return text.replace(KEY_TOKEN, "[redacted:dotenvx-key]").replace(PRIVATE_KEY_VALUE, "$1[redacted:dotenvx-key]");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hasEncryptedEntries(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    const eq = trimmed.indexOf("=");
    if (eq < 1) return false;
    const name = trimmed.slice(0, eq).trim();
    if (name.startsWith("DOTENV_PRIVATE_KEY_")) return false;
    const value = unquote(trimmed.slice(eq + 1));
    return value.startsWith("encrypted:") || (value.length >= 40 && /^[A-Za-z0-9+/=]+$/.test(value));
  });
}

async function getPrivateKeyMetadata(filePath: string): Promise<PrivateKeyMetadata | undefined> {
  try {
    // stat (not lstat): a symlink to a regular keys file is still a keys file.
    const info = await stat(filePath);
    if (!info.isFile()) return undefined;
    const content = await readFile(filePath, "utf8");
    const names: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(PRIVATE_KEY_LINE);
      if (match && !names.includes(match[1]!)) names.push(match[1]!);
    }
    return {
      name: path.basename(filePath),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      count: names.length,
      entryNames: names,
    };
  } catch {
    return undefined;
  }
}

/** Collect environment metadata without returning environment or private-key values. */
export async function collectSafeInfo(cwd: string): Promise<SafeInfo> {
  const root = path.resolve(cwd);
  const entries = await readdir(root, { withFileTypes: true });
  const environments: SafeEnvironmentFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/^\.env(?:\..+)?$/.test(entry.name) || entry.name === ".env.keys" || entry.name.endsWith(".keys")) continue;
    const filePath = path.join(root, entry.name);
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const appEnvLine = contents.split(/\r?\n/).find((line) => /^\s*APP_ENV\s*=/.test(line));
    const appEnv = appEnvLine ? unquote(appEnvLine.slice(appEnvLine.indexOf("=") + 1)) : undefined;
    environments.push({
      name: entry.name,
      ...(appEnv ? { appEnv } : {}),
      hasEncryptedEntries: hasEncryptedEntries(contents),
    });
  }
  environments.sort((a, b) => a.name.localeCompare(b.name));

  const projectKeys = await getPrivateKeyMetadata(path.join(root, ".env.keys"));
  const homeKeysPath = path.join(os.homedir(), ".dotenvx", ".env.keys");
  let dotenvxHomeKeysExists = false;
  try {
    dotenvxHomeKeysExists = (await stat(homeKeysPath)).isFile();
  } catch {
    // Missing home key file is safe metadata.
  }

  return {
    cwd: root,
    environments,
    ...(projectKeys ? { privateKeysFile: projectKeys } : {}),
    dotenvxHomeKeysExists,
  };
}
