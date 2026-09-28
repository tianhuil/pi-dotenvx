import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bashReferencesProtected,
  collectSafeInfo,
  isProtectedPath,
  redactSecrets,
} from "../../src/guard.ts";

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dotenvx-guard-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isProtectedPath", () => {
  test("protects .env.keys by absolute and cwd-relative path", async () => {
    const cwd = await makeTempDir();
    const keyFile = path.join(cwd, ".env.keys");
    await writeFile(keyFile, "fake fixture only");

    expect(isProtectedPath(keyFile, cwd)).toBe(true);
    expect(isProtectedPath(".env.keys", cwd)).toBe(true);
  });

  test("protects paths under a custom protected directory", async () => {
    const cwd = await makeTempDir();
    const protectedDir = path.join(cwd, "private");
    await mkdir(path.join(protectedDir, "nested"), { recursive: true });
    const target = path.join(protectedDir, "nested", "notes.txt");
    await writeFile(target, "fake fixture only");

    expect(isProtectedPath(target, cwd, [], [protectedDir])).toBe(true);
    expect(isProtectedPath(path.relative(cwd, target), cwd, [], [protectedDir])).toBe(true);
  });

  test("blocks an innocently named symlink whose target is .env.keys", async () => {
    const cwd = await makeTempDir();
    const target = path.join(cwd, ".env.keys");
    const alias = path.join(cwd, "ordinary-data.txt");
    await writeFile(target, "fake fixture only");
    await symlink(target, alias);

    expect(isProtectedPath(alias, cwd)).toBe(true);
  });

  test("resolves a missing child through a symlinked protected directory", async () => {
    const cwd = await makeTempDir();
    const protectedDir = path.join(await makeTempDir(), "protected");
    await mkdir(protectedDir);
    const alias = path.join(cwd, "ordinary-data");
    await symlink(protectedDir, alias);

    expect(isProtectedPath(path.join(alias, "newfile"), cwd, [], [protectedDir])).toBe(true);
  });

  test("does not protect ordinary dotenv files or unrelated paths", async () => {
    const cwd = await makeTempDir();

    for (const candidate of [".env", ".env.development", ".env.keys.bak", "unrelated.txt"]) {
      expect(isProtectedPath(candidate, cwd)).toBe(false);
    }
  });

  test("honors custom protected names and directories", async () => {
    const cwd = await makeTempDir();
    const customName = path.join(cwd, "secrets.local");
    const customDir = path.join(cwd, "private");
    await mkdir(customDir);
    await writeFile(customName, "fake fixture only");
    const customChild = path.join(customDir, "child.txt");
    await writeFile(customChild, "fake fixture only");

    expect(isProtectedPath(customName, cwd, ["secrets.local"], [])).toBe(true);
    expect(isProtectedPath(customChild, cwd, [], [customDir])).toBe(true);
    expect(isProtectedPath(".env.keys", cwd, ["secrets.local"], [])).toBe(false);
  });
});

describe("bashReferencesProtected", () => {
  // This text scan is advisory and bypassable; it is not an OS-level access boundary.
  test("recognizes obvious protected-file references and globs", () => {
    expect(bashReferencesProtected("cat .env.keys")).toBe(true);
    expect(bashReferencesProtected("head .?nv.keys")).toBe(true);
    expect(bashReferencesProtected("cat .env*keys")).toBe(true);
    expect(bashReferencesProtected("grep x .env.production.keys")).toBe(true);
  });

  test("leaves ordinary environment paths alone and records actual .env.keys.bak behavior", () => {
    expect(bashReferencesProtected("cat .env")).toBe(false);
    expect(bashReferencesProtected("ls .env.development")).toBe(false);
    // The implementation uses substring matching, so this suffixed name currently matches.
    expect(bashReferencesProtected("cat .env.keys.bak")).toBe(true);
  });
});

describe("redactSecrets", () => {
  test("redacts dotenvx key tokens", () => {
    const token = `key_${"A".repeat(44)}`;
    expect(redactSecrets(`private=${token}`)).toBe("private=[redacted:dotenvx-key]");
  });

  test("redacts private-key assignment values while preserving variable names", () => {
    const text = `DOTENV_PRIVATE_KEY_DEVELOPMENT=${"fake-value-".repeat(4)}`;
    expect(redactSecrets(text)).toBe("DOTENV_PRIVATE_KEY_DEVELOPMENT=[redacted:dotenvx-key]");
  });

  test("redacts short private-key values but leaves ordinary short and encrypted values untouched", () => {
    const text = [
      "normal text",
      "DOTENV_PRIVATE_KEY_X=abc123",
      "SHORT_VALUE=abc123",
      "API_KEY=encrypted:AREALLYFAKEVALUEFORTESTS",
    ].join("\n");
    expect(redactSecrets(text)).toBe([
      "normal text",
      "DOTENV_PRIVATE_KEY_X=[redacted:dotenvx-key]",
      "SHORT_VALUE=abc123",
      "API_KEY=encrypted:AREALLYFAKEVALUEFORTESTS",
    ].join("\n"));
  });
});

describe("collectSafeInfo", () => {
  test("returns environment metadata and key names without fixture secret values", async () => {
    const fixtureDir = path.resolve(import.meta.dir, "../fixtures/env-project");
    const result = await collectSafeInfo(fixtureDir);
    const json = JSON.stringify(result);

    expect(result.environments).toEqual([
      { name: ".env.development", appEnv: "development", hasEncryptedEntries: false },
      { name: ".env.production", appEnv: "production", hasEncryptedEntries: true },
    ]);
    expect(result.privateKeysFile).toBeDefined();
    expect(result.privateKeysFile?.count).toBe(2);
    expect(result.privateKeysFile?.entryNames).toEqual([
      "DOTENV_PRIVATE_KEY_DEVELOPMENT",
      "DOTENV_PRIVATE_KEY_PRODUCTION",
    ]);

    expect(json).not.toContain("key_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(json).not.toContain("key_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(json).not.toContain("AREALLYFAKEVALUEFORTESTS");
  });
});
  test("reports metadata for a symlinked .env.keys", async () => {
    const cwd = await makeTempDir();
    const realDir = await makeTempDir();
    const realKeys = path.join(realDir, "real.keys");
    await writeFile(realKeys, "DOTENV_PRIVATE_KEY_DEVELOPMENT=key_" + "C".repeat(44) + "\n");
    await symlink(realKeys, path.join(cwd, ".env.keys"));
    await writeFile(path.join(cwd, ".env.development"), "APP_ENV=development\n");

    const result = await collectSafeInfo(cwd);
    expect(result.privateKeysFile).toBeDefined();
    expect(result.privateKeysFile?.count).toBe(1);
    expect(result.privateKeysFile?.entryNames).toEqual(["DOTENV_PRIVATE_KEY_DEVELOPMENT"]);
    expect(JSON.stringify(result)).not.toContain("key_C");
  });

  test("redaction does not swallow the line after an empty private-key assignment", () => {
    const text = "DOTENV_PRIVATE_KEY_DEVELOPMENT=\nNEXT=ordinary\n";
    expect(redactSecrets(text)).toBe("DOTENV_PRIVATE_KEY_DEVELOPMENT=\nNEXT=ordinary\n");
  });
