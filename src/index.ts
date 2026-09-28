import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bashReferencesProtected,
  collectSafeInfo,
  DEFAULT_PROTECTED_DIRS,
  DEFAULT_PROTECTED_NAMES,
  isProtectedPath,
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "dotenvx_info",
    label: "dotenvx safe info",
    description: "Report safe dotenvx metadata for the current project. Never returns environment values or private-key values.",
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const info = await collectSafeInfo(ctx.cwd);
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], details: {} };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = mergeConfig(ctx.cwd);
    if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path;
      if (typeof filePath === "string" && await isProtectedPath(filePath, ctx.cwd, config.protectedNames, config.protectedDirs)) {
        return { block: true, reason: `Blocked access to protected dotenvx path. Use dotenvx_info for safe environment metadata.` };
      }
    }
    if (event.toolName === "bash") {
      const command = event.input.command;
      if (typeof command === "string" && bashReferencesProtected(command, config.protectedNames)) {
        return { block: true, reason: "Blocked command referencing a protected dotenvx key file. Use dotenvx_info for safe environment metadata." };
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
    systemPrompt: `${event.systemPrompt}\n.env.keys is off-limits; never read, print, or copy it. Use the dotenvx_info tool for dotenvx environment questions.`,
  }));
}
