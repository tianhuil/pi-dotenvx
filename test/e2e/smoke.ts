import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const extensionEntry = path.join(import.meta.dir, "smoke-probe.ts");
const timeoutMs = 60_000;

function findPiBinary(): string {
  const candidates = [
    process.env.PI_BIN,
    path.join(repoRoot, "node_modules", ".bin", "pi"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "pi");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find pi CLI. Set PI_BIN or install pi on PATH.");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const piBinary = findPiBinary();
const cwd = await mkdtemp(path.join(os.tmpdir(), "dotenvx-guard-pi-smoke-"));
const args = [
  "--mode", "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--offline",
  "--extension", extensionEntry,
];
const frames: Record<string, unknown>[] = [];
let stdoutBuffer = "";
let stderr = "";
let timedOut = false;
let parseError: Error | undefined;

const child = spawn(piBinary, args, {
  cwd,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

const watchdog = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
}, timeoutMs);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const frame: unknown = JSON.parse(line);
      if (typeof frame === "object" && frame !== null) frames.push(frame as Record<string, unknown>);
    } catch (error) {
      parseError = new Error(`Pi emitted non-JSON RPC output: ${line.slice(0, 300)}`, { cause: error });
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => { stderr += chunk; });

// RPC has no initialize handshake. A successful get_state response is its
// documented request/response proof that startup completed.
child.stdin.write('{"id":"smoke-state","type":"get_state"}\n');
child.stdin.write('{"id":"smoke-commands","type":"get_commands"}\n');
child.stdin.end();

try {
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(watchdog);

  if (stdoutBuffer.trim()) {
    try {
      const frame: unknown = JSON.parse(stdoutBuffer.replace(/\r$/, ""));
      if (typeof frame === "object" && frame !== null) frames.push(frame as Record<string, unknown>);
    } catch (error) {
      parseError ??= new Error(`Pi emitted invalid final RPC output: ${stdoutBuffer.slice(0, 300)}`, { cause: error });
    }
  }

  assert(!timedOut, `Pi RPC smoke exceeded ${timeoutMs}ms`);
  assert(!parseError, parseError?.message ?? "Pi emitted invalid RPC output");
  assert(exitCode === 0, `Pi exited ${exitCode}. stderr: ${stderr || "(empty)"}`);

  const extensionErrors = frames.filter((frame) => frame.type === "extension_error");
  assert(extensionErrors.length === 0, `Extension errors: ${JSON.stringify(extensionErrors)}`);

  const stateResponse = frames.find((frame) => frame.type === "response" && frame.id === "smoke-state");
  assert(stateResponse?.success === true, `RPC did not initialize successfully: ${JSON.stringify(stateResponse ?? frames)}`);

  const commandsResponse = frames.find((frame) => frame.type === "response" && frame.id === "smoke-commands");
  assert(commandsResponse?.success === true, `RPC get_commands failed: ${JSON.stringify(commandsResponse ?? frames)}`);

  // The smoke probe runs the live guard logic inside pi and exposes the
  // result through a marker command surfaced by the documented get_commands
  // RPC frame. Assert the extension's behavior, not just its presence.
  const commands = commandsResponse.data && typeof commandsResponse.data === "object"
    ? (commandsResponse.data as { commands?: unknown }).commands
    : undefined;
  const marker = Array.isArray(commands)
    ? commands.find((command) => typeof command === "object" && command !== null && (command as { name?: unknown }).name === "dotenvx-guard-smoke") as { description?: unknown } | undefined
    : undefined;
  const description = typeof marker?.description === "string" ? marker.description : "";
  const expected = [
    '"sanctionedCat":true',
    '"sanctionedLs":true',
    '"sneakyExtraArg":false',
    '"blockedGlob":true',
    '"blockedRead":true',
    '"redaction":"DOTENV_PRIVATE_KEY_PRODUCTION=[redacted]"',
  ];
  for (const fragment of expected) {
    assert(description.includes(fragment), `Guard probe missing ${fragment}: ${description || JSON.stringify(commandsResponse)}`);
  }
  console.log("PASS: pi RPC loaded dotenvx-guard with sanctioned commands, gate, and redaction live");
  console.log(`Pi binary: ${piBinary}`);
  console.log(`Pi args: ${args.join(" ")}`);
} finally {
  clearTimeout(watchdog);
  if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  await rm(cwd, { recursive: true, force: true });
}
