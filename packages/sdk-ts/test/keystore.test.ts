import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentBankError, loadOrCreateKey, MemoryKeyStore } from "../src";
import { FileKeyStore } from "../src/node";

const posix = process.platform !== "win32";

describe("MemoryKeyStore", () => {
  it("stores, lists, deletes and never serializes keys", async () => {
    const store = new MemoryKeyStore();
    const key = generatePrivateKey();
    await store.set("session:ses_1", key);
    expect(await store.get("session:ses_1")).toBe(key);
    expect(await store.list()).toEqual(["session:ses_1"]);
    expect(JSON.stringify(store)).not.toContain(key.slice(2));
    expect(await store.delete("session:ses_1")).toBe(true);
    expect(await store.delete("session:ses_1")).toBe(false);
    await expect(store.set("bad name!", key)).rejects.toBeInstanceOf(AgentBankError);
    await expect(store.set("ok", "0x1234" as `0x${string}`)).rejects.toThrow(/32-byte/);
  });

  it("loadOrCreateKey creates once and then reuses", async () => {
    const store = new MemoryKeyStore();
    const a = await loadOrCreateKey(store, "spend");
    const b = await loadOrCreateKey(store, "spend");
    expect(a.address).toBe(b.address);
  });
});

describe("FileKeyStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentbank-keys-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a 0600 file in a 0700 directory and round-trips keys", async () => {
    const path = join(dir, "nested", "agent.keystore.json");
    const store = new FileKeyStore({ path });
    const key = generatePrivateKey();
    await store.set("session", key);
    await store.set("spend", generatePrivateKey());
    expect(await store.get("session")).toBe(key);
    expect(await store.list()).toEqual(["session", "spend"]);
    expect((await store.addresses()).session).toBe(privateKeyToAccount(key).address);
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file).toMatchObject({ version: 1, chain_id: 84532 });
    expect(file.warning).toMatch(/TESTNET KEYS ONLY/);
    if (posix) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
    }
    expect(JSON.stringify(store)).not.toContain(key.slice(2));
    expect(await store.delete("spend")).toBe(true);
    expect(await new FileKeyStore({ path }).list()).toEqual(["session"]);
  });

  it.runIf(posix)("refuses to read a world- or group-readable key file", async () => {
    const path = join(dir, "keys.json");
    const store = new FileKeyStore({ path });
    await store.set("session", generatePrivateKey());
    await chmod(path, 0o644);
    const error = await store.get("session").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentBankError);
    expect((error as AgentBankError).code).toBe("forbidden");
    expect((error as Error).message).toContain("chmod 600");
    await chmod(path, 0o640);
    await expect(store.list()).rejects.toThrow(/group or others/);
    await chmod(path, 0o600);
    await expect(store.list()).resolves.toEqual(["session"]);
  });

  it("refuses mainnet chains and files written for another chain", async () => {
    expect(() => new FileKeyStore({ path: join(dir, "k.json"), chainId: 8453 })).toThrow(/mainnet/i);
    const path = join(dir, "mainnet.json");
    await writeFile(path, JSON.stringify({ version: 1, chain_id: 1, keys: {} }), { mode: 0o600 });
    const error = await new FileKeyStore({ path }).list().catch((e: unknown) => e);
    expect((error as AgentBankError).code).toBe("mainnet_locked");
    const anvil = join(dir, "anvil.json");
    await writeFile(anvil, JSON.stringify({ version: 1, chain_id: 31337, keys: {} }), { mode: 0o600 });
    await expect(new FileKeyStore({ path: anvil }).list()).rejects.toThrow(/chain 31337/);
  });

  it("rejects malformed files without echoing their contents", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, '{"version":1,"keys":{"session":{"private_key":"0xsecret"}}}', { mode: 0o600 });
    const error = await new FileKeyStore({ path }).get("session").catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("secret");
  });
});
