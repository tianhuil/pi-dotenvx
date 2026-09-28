# pi-dotenvx

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-orange?logo=bun)](https://bun.sh)
[![CI](https://github.com/tianhuil/pi-dotenvx/actions/workflows/ci.yml/badge.svg)](https://github.com/tianhuil/pi-dotenvx/actions/workflows/ci.yml)

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that keeps the coding agent away from [dotenvx](https://dotenvx.com) private-key files (`.env.keys`) — except for two sanctioned commands whose output is automatically redacted.

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

Confirm it loaded: ask the agent to run `cat .env.keys` — it should succeed with key values showing as `[redacted]` — or run this repo's smoke test locally (see [Development](#development)).

## How it works

Four layers, applied to every agent turn:

| Layer | Trigger | Behavior |
|---|---|---|
| Tool gate | `read` / `write` / `edit` on a protected path | Blocked, with a reason pointing at the sanctioned commands. Path is canonicalized (`~` expansion, cwd resolution, realpath through symlinks, nearest-existing-ancestor fallback) so symlink and missing-child evasions fail. |
| Bash gate | `bash` command referencing a protected name | Blocked — **except** the two sanctioned commands below. Advisory text scan — see [Security model](#security-model). |
| Redaction | any `tool_result` containing key material | `key_…` tokens (40+ base64 chars) and `DOTENV_PRIVATE_KEY_*=<value>` assignments are replaced with `[redacted]`. This is what makes the sanctioned commands safe. |
| Guidance | each agent start | System prompt gains: `.env.keys` is off-limits; use `cat .env.keys` / `ls .env.keys`; plain `.env*` files are safe to read normally. |

### Sanctioned commands

Exactly two commands pass the bash gate — matched after trimming, with no extra arguments allowed:

```sh
cat .env.keys
ls .env.keys
```

- `ls .env.keys` tells the agent whether the file exists at the repo root.
- `cat .env.keys` returns the verbatim file with every key value replaced by `[redacted]`; when the file is missing, cat's natural `No such file or directory` answers the question. Key **names** survive (`DOTENV_PRIVATE_KEY_DEVELOPMENT`, …) — names are metadata, not secrets.

Because redaction is applied to all tool results anyway, these commands need no special output path — the backstop *is* the feature.

Sample redacted session:

```sh
$ ls .env.keys
.env.keys
$ cat .env.keys
# .env.keys
DOTENV_PRIVATE_KEY_DEVELOPMENT=[redacted]
DOTENV_PRIVATE_KEY_PRODUCTION=[redacted]
$ cat .env.keys   # in a repo without the file
cat: .env.keys: No such file or directory
```

Plain environment files (`.env`, `.env.development`, `.env.test`, `.env.production`, …) are not protected — the agent reads them normally. Only `.env.keys` (and configured dirs like `~/.dotenvx`) is guarded.

### Conditional activation

The guard silently no-ops unless `.env.keys` exists at the repo root — the single telltale sign of dotenvx usage. Detection runs at session start and is re-checked each turn (one `stat`), so a repo that gains `.env.keys` mid-session wakes the guard immediately. Other dotenvx hints (package.json dependencies, `encrypted:` values) deliberately do **not** activate it; a project without `.env.keys` has nothing to protect.

Fail direction is safe: file present → active. Override in config with `"enabled": true` (always on) or `"enabled": false` (off):

```json
{ "enabled": "auto" }
```

Redaction still runs in dormant projects — it is a near-free backstop and only ever matches real key material.

### Configuration

Optional JSON config, merged with defaults (project wins):

- Global: `dotenvx-guard.json` next to the installed package
- Project: `<project>/.pi/dotenvx-guard.json`

Supported keys: `enabled` (`"auto"` default, `true`, `false`), `protectedNames`, `protectedDirs`.

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
               sanctioned-command pass-through, guidance injection, config merge
src/guard.ts   pure logic: path canonicalization + matching, sanctioned-command
               check, bash text scan, secret redaction (no pi imports)
test/unit/     bun:test unit tests for guard.ts (evasion, sanctions, redaction)
test/e2e/      smoke test driving the real pi CLI in rpc mode (no API key):
               asserts clean load + live gate/redaction behavior
```

## Security model

Honest threat model:

- **Hard within pi:** `read`/`write`/`edit` cannot touch protected paths, including via symlinks or not-yet-existing targets under symlinked directories. Sanctioned commands carry no secret values because redaction scrubs every tool result.
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
- [ ] Config option to sanction additional read-only commands (e.g. `ls ~/.dotenvx`)
- [ ] Publish to npm for `npm:` installs alongside `git:`
- [ ] Support `PI_BIN`-pinned e2e matrix across pi versions in CI

## License

[MIT](LICENSE) © 2026 tianhuil
