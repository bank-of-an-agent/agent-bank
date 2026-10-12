import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyStore } from "@agentbank/sdk/node";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, createAgentClient, loadConfig } from "../src";

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentbank-mcp-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads keys from the environment", async () => {
    const session = generatePrivateKey();
    const spend = generatePrivateKey();
    const config = await loadConfig({
      AGENTBANK_API_URL: "https://sandbox.example.test/",
      AGENTBANK_ACCOUNT_ID: ACCT,
      AGENTBANK_SESSION_ID: SES,
      AGENTBANK_SESSION_KEY: session,
      AGENTBANK_SPEND_KEY: spend,
      AGENTBANK_MAX_X402_PER_CALL: "0.5",
    });
    expect(config).toMatchObject({
      apiUrl: "https://sandbox.example.test",
      accountId: ACCT,
      sessionId: SES,
      maxX402PerCall: "0.50",
      sessionKeySource: "env",
    });
    expect(config.sessionKey.address).toBe(privateKeyToAccount(session).address);
    expect(config.spendKey?.address).toBe(privateKeyToAccount(spend).address);
    const client = createAgentClient(config);
    expect(client.accountId).toBe(ACCT);
    expect(client.spendKeyAddress).toBe(config.spendKey?.address);
  });

  it("reads keys from a FileKeyStore", async () => {
    const path = join(dir, "agent.keystore.json");
    const store = new FileKeyStore({ path });
    const session = generatePrivateKey();
    await store.set(`session:${SES}`, session);
    await store.set("spend", generatePrivateKey());
    const config = await loadConfig({
      AGENTBANK_ACCOUNT_ID: ACCT,
      AGENTBANK_SESSION_ID: SES,
      AGENTBANK_KEYSTORE: path,
    });
    expect(config.sessionKeySource).toBe("keystore");
    expect(config.sessionKey.address).toBe(privateKeyToAccount(session).address);
    expect(config.spendKey).toBeDefined();
    expect(config.apiUrl).toBe("http://localhost:8080");
    expect(config.maxX402PerCall).toBe("1.00");
  });

  it.runIf(process.platform !== "win32")(
    "refuses to start with a group/world-readable key store",
    async () => {
      const path = join(dir, "agent.keystore.json");
      await new FileKeyStore({ path }).set("session", generatePrivateKey());
      await chmod(path, 0o644);
      const error = await loadConfig({
        AGENTBANK_ACCOUNT_ID: ACCT,
        AGENTBANK_SESSION_ID: SES,
        AGENTBANK_KEYSTORE: path,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("chmod 600");
    },
  );

  it("reports problems by variable name without echoing secrets", async () => {
    const secretish = `0x${"z".repeat(64)}`;
    const cases: [Record<string, string>, RegExp][] = [
      [
        { AGENTBANK_SESSION_ID: SES, AGENTBANK_SESSION_KEY: generatePrivateKey() },
        /AGENTBANK_ACCOUNT_ID is required/,
      ],
      [{ AGENTBANK_ACCOUNT_ID: "agt_x", AGENTBANK_SESSION_ID: SES }, /AGENTBANK_ACCOUNT_ID must be/],
      [
        { AGENTBANK_ACCOUNT_ID: ACCT, AGENTBANK_SESSION_ID: SES },
        /AGENTBANK_SESSION_KEY or AGENTBANK_KEYSTORE/,
      ],
      [
        { AGENTBANK_ACCOUNT_ID: ACCT, AGENTBANK_SESSION_ID: SES, AGENTBANK_SESSION_KEY: secretish },
        /32-byte hex/,
      ],
      [
        {
          AGENTBANK_ACCOUNT_ID: ACCT,
          AGENTBANK_SESSION_ID: SES,
          AGENTBANK_SESSION_KEY: generatePrivateKey(),
          AGENTBANK_MAX_X402_PER_CALL: "1e3",
        },
        /AGENTBANK_MAX_X402_PER_CALL/,
      ],
      [
        {
          AGENTBANK_ACCOUNT_ID: ACCT,
          AGENTBANK_SESSION_ID: SES,
          AGENTBANK_SESSION_KEY: generatePrivateKey(),
          AGENTBANK_API_URL: "ftp://x",
        },
        /http\(s\) URL/,
      ],
      [
        {
          AGENTBANK_ACCOUNT_ID: ACCT,
          AGENTBANK_SESSION_ID: SES,
          AGENTBANK_KEYSTORE: join(dir, "missing.json"),
        },
        /No session key/,
      ],
    ];
    for (const [env, message] of cases) {
      const error = await loadConfig(env).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(secretish);
      for (const value of Object.values(env)) {
        if (/^0x[0-9a-f]{64}$/i.test(value)) expect((error as Error).message).not.toContain(value);
      }
    }
  });
});
