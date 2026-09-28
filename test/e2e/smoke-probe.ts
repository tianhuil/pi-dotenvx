import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bashReferencesProtected,
  isProtectedPath,
  isSanctionedCommand,
  redactSecrets,
} from "../../src/guard.ts";
import dotenvxGuard from "../../src/index.ts";

export default function (pi: ExtensionAPI) {
  dotenvxGuard(pi);
  pi.on("session_start", () => {
    // Expose live guard behavior through get_commands so the smoke test can
    // assert the extension's logic actually loaded into the running pi.
    const probe = {
      sanctionedCat: isSanctionedCommand("cat .env.keys"),
      sanctionedLs: isSanctionedCommand("ls .env.keys"),
      sneakyExtraArg: isSanctionedCommand("cat .env.keys /etc/passwd"),
      blockedGlob: bashReferencesProtected("cat .env*keys"),
      blockedRead: isProtectedPath(".env.keys", process.cwd()),
      redaction: redactSecrets(`DOTENV_PRIVATE_KEY_PRODUCTION=key_${"A".repeat(44)}`),
    };
    pi.registerCommand("dotenvx-guard-smoke", {
      description: `Guard probe: ${JSON.stringify(probe)}`,
      handler: async () => {},
    });
  });
}
