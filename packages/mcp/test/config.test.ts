import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyStore } from "@agentbank/sdk/node";
import { generateProofSecret } from "@agentbank/sdk";
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

  it("pays x402 on the deployment's network by default, or on AGENTBANK_X402_NETWORK", async () => {
    const base = {
      AGENTBANK_API_URL: "http://127.0.0.1:9",
      AGENTBANK_ACCOUNT_ID: ACCT,
      AGENTBANK_SESSION_ID: SES,
      AGENTBANK_SESSION_KEY: generatePrivateKey(),
    };
    expect((await loadConfig(base)).x402Network).toBeUndefined();
    const pinned = await loadConfig({ ...base, AGENTBANK_X402_NETWORK: "eip155:84532" });
    expect(pinned.x402Network).toBe("eip155:84532");
    // An explicit network resolves without asking GET /v1/meta (the API here is unreachable).
    expect(await createAgentClient(pinned).x402Settings()).toMatchObject({
      network: "eip155:84532",
      chainId: 84532,
    });
    await expect(loadConfig({ ...base, AGENTBANK_X402_NETWORK: "eip155:8453" })).rejects.toThrow(/mainnet/);
    await expect(loadConfig({ ...base, AGENTBANK_X402_NETWORK: "base-sepolia" })).rejects.toThrow(/CAIP-2/);
  });

  it("without an override, fetch_paid_resource's client follows the deployment's network (GET /v1/meta)", async () => {
    const meta = {
      object: "meta",
      api_version: "0.1.0",
      chain: "simulated",
      chain_id: 1337,
      caip2: "eip155:1337",
      owner_authorization_chain_id: 1337,
      usdc: {
        address: "0x5dC0000000000000000000000000000000005DC0",
        decimals: 6,
        eip712_name: "USDC",
        eip712_version: "2",
      },
      contracts: {},
      cosigner_address: null,
      revenue_address: null,
      facilitator_url: null,
      features: {},
    };
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/v1/meta" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/meta" ? meta : {}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const config = await loadConfig({
        AGENTBANK_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        AGENTBANK_ACCOUNT_ID: ACCT,
        AGENTBANK_SESSION_ID: SES,
        AGENTBANK_SESSION_KEY: generatePrivateKey(),
      });
      expect(await createAgentClient(config).x402Settings()).toMatchObject({
        network: "eip155:1337",
        chainId: 1337,
        usdc: "0x5dC0000000000000000000000000000000005DC0",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reads an optional proof secret (environment or key store) and enables proofs with it", async () => {
    const base = {
      AGENTBANK_ACCOUNT_ID: ACCT,
      AGENTBANK_SESSION_ID: SES,
      AGENTBANK_SESSION_KEY: generatePrivateKey(),
    };
    const without = await loadConfig(base);
    expect(without.proofSecret).toBeUndefined();
    expect(createAgentClient(without).proofs.canProve).toBe(false);

    const secret = generateProofSecret();
    const config = await loadConfig({ ...base, AGENTBANK_PROOF_SECRET: ` ${secret} ` });
    expect(config.proofSecret).toBe(secret);
    const client = createAgentClient(config);
    expect(client.proofs.canProve).toBe(true);
    expect(client.proofs.identityCommitment).toMatch(/^0x[0-9a-f]{64}$/);

    const path = join(dir, "agent.keystore.json");
    const store = new FileKeyStore({ path });
    await store.set("session", generatePrivateKey());
    await store.set(`proof:${ACCT}`, secret);
    const stored = await loadConfig({
      AGENTBANK_ACCOUNT_ID: ACCT,
      AGENTBANK_SESSION_ID: SES,
      AGENTBANK_KEYSTORE: path,
    });
    expect(stored.proofSecret).toBe(secret);

    // A key-store entry that is not a BN254 field element is refused by name, without its value.
    const outOfField: `0x${string}` = `0x4${"0".repeat(62)}1`;
    await store.set("proof", outOfField);
    await store.delete(`proof:${ACCT}`);
    const error = await loadConfig({
      AGENTBANK_ACCOUNT_ID: ACCT,
      AGENTBANK_SESSION_ID: SES,
      AGENTBANK_KEYSTORE: path,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/"proof" entry of AGENTBANK_KEYSTORE/);
    expect((error as Error).message).not.toContain(outOfField.slice(2));
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
      [
        {
          AGENTBANK_ACCOUNT_ID: ACCT,
          AGENTBANK_SESSION_ID: SES,
          AGENTBANK_SESSION_KEY: generatePrivateKey(),
          AGENTBANK_PROOF_SECRET: secretish,
        },
        /AGENTBANK_PROOF_SECRET must be a 0x-prefixed 32-byte hex/,
      ],
      [
        {
          AGENTBANK_ACCOUNT_ID: ACCT,
          AGENTBANK_SESSION_ID: SES,
          AGENTBANK_SESSION_KEY: generatePrivateKey(),
          AGENTBANK_PROOF_SECRET: `0x${"0".repeat(64)}`,
        },
        /AGENTBANK_PROOF_SECRET/,
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
