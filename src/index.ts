import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bashReferencesProtected,
  DEFAULT_PROTECTED_DIRS,
  DEFAULT_PROTECTED_NAMES,
  isProtectedPath,
  isSanctionedCommand,
  redactSecrets,
} from "./guard.ts";

interface GuardConfig {
  protectedNames?: string[];
  protectedDirs?: string[];
}

function readConfig(filePath: string): GuardConfig {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const config = parsed as GuardConfig;
    return {
      ...(Array.isArray(config.protectedNames) ? { protectedNames: config.protectedNames.filter((v): v is string => typeof v === "string") } : {}),
      ...(Array.isArray(config.protectedDirs) ? { protectedDirs: config.protectedDirs.filter((v): v is string => typeof v === "string") } : {}),
    };
  } catch {
    return {};
  }
}

function mergeConfig(cwd: string): Required<GuardConfig> {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const global = readConfig(path.join(extensionDir, "dotenvx-guard.json"));
  const project = readConfig(path.join(cwd, ".pi", "dotenvx-guard.json"));
  return {
    protectedNames: [...new Set([...DEFAULT_PROTECTED_NAMES, ...(project.protectedNames ?? global.protectedNames ?? [])])],
    protectedDirs: [...new Set([...DEFAULT_PROTECTED_DIRS, ...(project.protectedDirs ?? global.protectedDirs ?? [])])],
  };
}

const GUIDANCE = [
  ".env.keys holds dotenvx private decryption keys and is off-limits.",
  'The ONLY sanctioned commands are `cat .env.keys` and `ls .env.keys` (exact, no extra arguments) — their output is automatically redacted of key values.',
  "Never read, print, copy, move, or encode that file any other way.",
].join(" ");

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const config = mergeConfig(ctx.cwd);
    if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path;
      if (typeof filePath === "string" && await isProtectedPath(filePath, ctx.cwd, config.protectedNames, config.protectedDirs)) {
        return { block: true, reason: `Blocked access to protected dotenvx path. Run "cat .env.keys" or "ls .env.keys" instead — output is redacted of key values.` };
      }
    }
    if (event.toolName === "bash") {
      const command = event.input.command;
      if (typeof command === "string") {
        if (isSanctionedCommand(command)) return undefined;
        if (bashReferencesProtected(command, config.protectedNames)) {
          return { block: true, reason: `Blocked command referencing a protected dotenvx key file. Run "cat .env.keys" or "ls .env.keys" instead — output is redacted of key values.` };
        }
      }
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    let changed = false;
    const content = event.content.map((item) => {
      if (item.type !== "text") return item;
      const text = redactSecrets(item.text);
      if (text === item.text) return item;
      changed = true;
      return { ...item, text };
    });
    return changed ? { content } : undefined;
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n${GUIDANCE}`,
  }));
}
