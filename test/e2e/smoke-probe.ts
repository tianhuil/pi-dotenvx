import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dotenvxGuard from "../../src/index.ts";

export default function (pi: ExtensionAPI) {
  dotenvxGuard(pi);
  pi.on("session_start", () => {
    const tools = pi.getAllTools();

    // RPC exposes extension commands through get_commands. The marker includes
    // the runtime tool list so the smoke test can assert the tool's presence.
    pi.registerCommand("dotenvx-info-smoke", {
      description: `Runtime tools: ${JSON.stringify(tools)}`,
      handler: async () => {},
    });
  });
}
