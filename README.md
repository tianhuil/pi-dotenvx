# pi-dotenvx

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-orange?logo=bun)](https://bun.sh)
[![CI](https://github.com/tianhuil/pi-dotenvx/actions/workflows/ci.yml/badge.svg)](https://github.com/tianhuil/pi-dotenvx/actions/workflows/ci.yml)

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that keeps the coding agent away from [dotenvx](https://dotenvx.com) private-key files (`.env.keys`) and gives it one safe, dedicated tool for environment questions instead.

## Install

Prerequisite: pi 0.84+ (`pi --version`).

Install directly from this GitHub repo:

```sh
pi install git:github.com/tianhuil/pi-dotenvx
```

That writes the package into `~/.pi/agent/settings.json` and clones it under `~/.pi/agent/git/`. Restart pi (or run `pi update --extensions`) to activate.

To try it without installing:

```sh
pi -e git:github.com/tianhuil/pi-dotenvx
```

To install into a single project instead of globally, add `-l` (writes `.pi/settings.json` in the project):

```sh
pi install -l git:github.com/tianhuil/pi-dotenvx
```

Confirm it loaded: start pi and check that the `dotenvx_info` tool is available, or run this repo's smoke test locally (see [Development](#development)).

## How it works

Four layers, applied to every agent turn:

| Layer | Trigger | Behavior |
|---|---|---|
| Tool gate | `read` / `write` / `edit` on a protected path | Blocked. Path is canonicalized (`~` expansion, cwd resolution, realpath through symlinks, nearest-existing-ancestor fallback) so symlink and missing-child evasions fail. |
| Bash gate | `bash` command referencing a protected name | Blocked, with a reason pointing at `dotenvx_info`. Advisory text scan — see [Security model](#security-model). |
| Redaction | any `tool_result` containing key material | `key_…` tokens (40+ base64 chars) and `DOTENV_PRIVATE_KEY_*=<value>` assignments are replaced with `[redacted:dotenvx-key]`. Backstop, not a boundary. |
| Guidance | each agent start | System prompt gains: `.env.keys` is off-limits; use `dotenvx_info`. |

The one allowed path is the `dotenvx_info` tool (zero parameters, read-only). It reports, per project directory:

- `.env*` environment files present, each with its public `APP_ENV` value and whether it contains encrypted entries
- `.env.keys`: existence, size, mtime, entry count, and entry **names** (`DOTENV_PRIVATE_KEY_DEVELOPMENT`, …)
- whether `~/.dotenvx/.env.keys` exists

It never returns key values or environment secret values.

### Configuration

Optional JSON config, merged with defaults (project wins):

- Global: `dotenvx-guard.json` next to the installed package
- Project: `<project>/.pi/dotenvx-guard.json`

```json
{
  "protectedNames": [".env.keys", "secrets.keys"],
  "protectedDirs": ["~/.dotenvx", "./private"]
}
```

Defaults: `protectedNames: [".env.keys"]`, `protectedDirs: ["~/.dotenvx", "~/.dotenvx/.env.keys"]`.

## Architecture

```text
src/index.ts   extension factory: tool_call gate, tool_result redaction,
               dotenvx_info registration, guidance injection, config merge
src/guard.ts   pure logic: path canonicalization + matching, bash text scan,
               secret redaction, safe-info collection (no pi imports)
test/unit/     bun:test unit tests for guard.ts (evasion, redaction, leakage)
test/e2e/      smoke test driving the real pi CLI in rpc mode (no API key):
               asserts clean load + runtime dotenvx_info registration
```

## Security model

Honest threat model:

- **Hard within pi:** `read`/`write`/`edit` cannot touch protected paths, including via symlinks or not-yet-existing targets under symlinked directories. Tool results are scrubbed of key material.
- **Advisory:** the bash gate pattern-matches command text. It catches obvious references and glob shapes (`.env*keys`, `.?nv.keys`) but is bypassable by renames, encodings, or interpreters. It is a tripwire, not a boundary.
- **Robust follow-up (see TODO):** wrap bash in an OS sandbox (sandbox-exec / bubblewrap) with `denyRead` on key files for a kernel-enforced guarantee.
- **Out of scope:** keys already committed to Git history (rotate them), keys read before this extension was installed (purge old session transcripts), or exfiltration of already-decrypted values.

## Development

Requires [Bun](https://bun.sh) 1.1+.

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test test/unit/ # unit tests
bun run test:e2e    # pi CLI smoke test (uses the locally installed pi; PI_BIN overrides)
```

CI runs all three on every push and pull request.

## TODO

- [ ] OS-level sandbox for bash commands (`@anthropic-ai/sandbox-runtime`, `denyRead` on `.env.keys`) to replace the advisory text scan with a kernel-enforced boundary
- [ ] Block subagent-spawned children that bypass the extension's tool gate (verify coverage of pi-subagents child tool calls)
- [ ] Config option to protect additional dotenvx-adjacent secrets (e.g. `.env.vault` keys) by default
- [ ] Publish to npm as `pi-dotenvx` for `npm:` installs alongside `git:`
- [ ] Support `PI_BIN`-pinned e2e matrix across pi versions in CI

## License

[MIT](LICENSE) © 2026 tianhuil
