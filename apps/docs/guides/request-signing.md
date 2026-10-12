# Request signing

Agents authenticate with **HTTP Message Signatures** ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)) made by their session key, not with static API keys: there is no bearer secret to leak from an agent's context or logs, and each signature is short-lived and single-use. The session key is secp256k1, because the same key signs the agent's on-chain operations, and RFC 9421's algorithm registry has no secp256k1 entry, so Agent Bank defines an application-specific algorithm, **`eip191-secp256k1`**: the signature base is signed as an EIP-191 personal message, which any Ethereum signer (viem, eth-account, a hardware wallet, a KMS key) can produce ([ADR 0007](/operations/adrs)).

The SDKs and the MCP server do all of this for you. This page is the specification for other languages and for debugging.

## Profile

| Item                 | Value                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature label      | `agentbank`                                                                                                                                 |
| `alg`                | `eip191-secp256k1`                                                                                                                          |
| `keyid`              | The session id (`ses_…`)                                                                                                                    |
| `tag`                | `agentbank`                                                                                                                                 |
| Covered components   | `@method`, `@target-uri`, then `content-digest` when the request has a body, then `idempotency-key` when that header is sent, in this order |
| `created`, `expires` | Unix seconds; `expires - created` at most **300**; the SDKs use 120                                                                         |
| `nonce`              | Random and **single-use** per key (the SDKs use 16 random bytes, base64url)                                                                 |
| `Content-Digest`     | [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530) `sha-256=:<base64 of SHA-256 of the exact body bytes>:`                                  |
| Clock skew           | `created` may be at most 30 seconds in the future                                                                                           |

## Building the signature

1. If there is a body, compute `Content-Digest` over the exact bytes you will send, and send it as a header.
2. Build the **signature base**: one line per covered component, `"<name>": <value>`, then a final `"@signature-params": <params>` line, joined with `\n` (no trailing newline).
   - `@method` is the method in upper case.
   - `@target-uri` is the absolute request URL (scheme, host, path and query) as a WHATWG URL serializes it.
   - Header components use the lowercase header name and the trimmed header value.
3. Serialize the parameters exactly as `("@method" "@target-uri" …);created=<n>;expires=<n>;nonce="<s>";keyid="<s>";alg="eip191-secp256k1";tag="agentbank"`.
4. Sign the base as an EIP-191 personal message: secp256k1 over `keccak256("\x19Ethereum Signed Message:\n" + len(base) + base)`, giving the 65-byte `r ‖ s ‖ v` signature.
5. Send:
   - `Signature-Input: agentbank=<params>`
   - `Signature: agentbank=:<base64 of the 65 signature bytes>:`

Re-sign every retry with a fresh `created` and `nonce`; the idempotency key stays the same.

A complete implementation in TypeScript with viem, which reproduces the test vectors below:

```ts
import { createHash, randomBytes } from "node:crypto";
import type { PrivateKeyAccount } from "viem/accounts";

export async function signAgentRequest(
  req: { method: string; url: string; body?: string; idempotencyKey?: string },
  session: { id: string; signer: PrivateKeyAccount },
  now = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const components = ["@method", "@target-uri"];
  const lines = [`"@method": ${req.method.toUpperCase()}`, `"@target-uri": ${new URL(req.url).toString()}`];
  if (req.body) {
    const digest = `sha-256=:${createHash("sha256").update(req.body).digest("base64")}:`;
    headers["content-digest"] = digest;
    components.push("content-digest");
    lines.push(`"content-digest": ${digest}`);
  }
  if (req.idempotencyKey !== undefined) {
    components.push("idempotency-key");
    lines.push(`"idempotency-key": ${req.idempotencyKey.trim()}`);
  }
  const nonce = randomBytes(16).toString("base64url");
  const params =
    `(${components.map((c) => `"${c}"`).join(" ")})` +
    `;created=${now};expires=${now + 120};nonce="${nonce}";keyid="${session.id}";alg="eip191-secp256k1";tag="agentbank"`;
  lines.push(`"@signature-params": ${params}`);
  const signature = await session.signer.signMessage({ message: lines.join("\n") });
  headers["signature-input"] = `agentbank=${params}`;
  headers["signature"] = `agentbank=:${Buffer.from(signature.slice(2), "hex").toString("base64")}:`;
  return headers;
}
```

In Python, `agentbank.sign_request`, `verify_request` and `content_digest` implement the same profile.

## Verification

The API verifies each agent request in this order and answers `unauthorized` or `signature_invalid` (HTTP 401) with the precise reason:

1. Both `Signature-Input` and `Signature` are present, well formed and use the same label.
2. `alg` is `eip191-secp256k1`.
3. The signature covers `@method` and `@target-uri`; `content-digest` when there is a body, and the header matches the body; `idempotency-key` when that header is sent.
4. `created` is not more than 30 seconds in the future, `expires` has not passed, and the lifetime is at most 300 seconds.
5. `keyid` names a live session; its registered key address is the expected signer.
6. The signer recovered from the rebuilt base equals that address.
7. The `(keyid, nonce)` pair was never seen before (nonces are kept until they expire).

## Test vectors

The shared vectors live in `packages/core/test/vectors/vectors.json` and are regenerated deterministically with `pnpm --filter @agentbank/core vectors` (fixed keys, timestamps and nonces; ECDSA is RFC 6979 deterministic). The TypeScript and Python SDKs both reproduce them byte for byte in CI. The keys are well-known public Anvil development keys: **never use them for real funds**.

| Key                 | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| Session private key | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| Session address     | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`                         |
| Owner private key   | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| Owner address       | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`                         |

### POST with a body and an idempotency key

Request: `POST https://api.example.test/v1/payments` with headers `content-type: application/json` and `idempotency-key: idem-0001-0002`, and this exact body (no whitespace, no trailing newline):

```text
{"account_id":"acct_01JABCDEFGHJKMNPQRSTVWXYZ0","amount":{"amount":"12.50","asset":"USDC"},"to":{"address":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"},"memo":"dataset purchase"}
```

Parameters: `keyid` `ses_01JABCDEFGHJKMNPQRSTVWXYZ0`, `created` 1790000000, lifetime 120 seconds, `nonce` `bm9uY2Utdm-VjdG9y`.

Signature base:

```text
"@method": POST
"@target-uri": https://api.example.test/v1/payments
"content-digest": sha-256=:JnrG9k8U8oe5qWAovDjCedD3qlPwBgt+dQyQVd9lzxY=:
"idempotency-key": idem-0001-0002
"@signature-params": ("@method" "@target-uri" "content-digest" "idempotency-key");created=1790000000;expires=1790000120;nonce="bm9uY2Utdm-VjdG9y";keyid="ses_01JABCDEFGHJKMNPQRSTVWXYZ0";alg="eip191-secp256k1";tag="agentbank"
```

Headers:

```http
Content-Digest: sha-256=:JnrG9k8U8oe5qWAovDjCedD3qlPwBgt+dQyQVd9lzxY=:
Signature-Input: agentbank=("@method" "@target-uri" "content-digest" "idempotency-key");created=1790000000;expires=1790000120;nonce="bm9uY2Utdm-VjdG9y";keyid="ses_01JABCDEFGHJKMNPQRSTVWXYZ0";alg="eip191-secp256k1";tag="agentbank"
Signature: agentbank=:6DYyN0m6CNNR48KXcTploGp1iSOj8Srji0Ay3zkJ68p8Ml6Xaq/re++93oSFhsgbv/L7oChCbTwv7GEv+zVrVRs=:
```

### GET without a body

Request: `GET https://api.example.test/v1/accounts/acct_01JABCDEFGHJKMNPQRSTVWXYZ0/balances`, no headers. Parameters: `created` 1790000100, lifetime 60 seconds, `nonce` `Z2V0LW5vbmNl`.

```http
Signature-Input: agentbank=("@method" "@target-uri");created=1790000100;expires=1790000160;nonce="Z2V0LW5vbmNl";keyid="ses_01JABCDEFGHJKMNPQRSTVWXYZ0";alg="eip191-secp256k1";tag="agentbank"
Signature: agentbank=:w42OKNa1yM06WL+NhSJ/FuxbFk0usz4WXkSzEu2mnnd1O5ekd/Rj39YLt+Nz2fFhAbzyMMnJjgQ83lIKXgiPgBs=:
```

## Operation hashes

Payments, escrows and streams return a `signing_request.user_op_hash`, and owner operations a `user_op_hash`. These are signed differently from requests: as an EIP-191 personal message over the **raw 32 bytes** of the hash (`"\x19Ethereum Signed Message:\n32" + hash`), the format the Smart Sessions and owner validators verify (`OPERATION_HASH_SIGNING = "eip191-raw-bytes32"`).

```ts
const signature = await sessionKey.signMessage({ message: { raw: payment.signing_request.user_op_hash } });
```

```python
from eth_account.messages import encode_defunct
signature = account.sign_message(encode_defunct(primitive=bytes.fromhex(user_op_hash[2:]))).signature
```

The SDKs refuse to sign anything that is not exactly 32 bytes of hex here, so a compromised API cannot make a session key sign arbitrary text, and they check that the payment the API prepared matches the request before signing.

## Owner authorizations

Changes that need the owner carry an EIP-712 `OwnerAuthorization` (see [Owner operations](/concepts/owner-operations#owner-authorizations)):

```text
domain  = { name: "Agent Bank", version: "1", chainId }
types   = { OwnerAuthorization: [ { action: string }, { subject: string }, { payloadHash: bytes32 },
                                  { issuedAt: uint64 }, { expiresAt: uint64 } ] }
payloadHash = keccak256(utf8(canonicalJson(payload)))
```

**Canonical JSON** (RFC 8785 style): object keys sorted by code point, no insignificant whitespace, members whose value is undefined dropped, non-finite numbers rejected, big integers as decimal strings. Vector: `{"b":1,"a":[2,{"d":null,"c":"x"}],"e":"ü"}` becomes `{"a":[2,{"c":"x","d":null}],"b":1,"e":"ü"}`.

| Field                   | Vector value                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chainId`               | `84532`                                                                                                                                                                   |
| `action`                | `policy.loosen`                                                                                                                                                           |
| `subject`               | `agt_01JABCDEFGHJKMNPQRSTVWXYZ0`                                                                                                                                          |
| Payload, canonical JSON | `{"agent":"agt_01JABCDEFGHJKMNPQRSTVWXYZ0","counterparties":{"mode":"allowlist","x402_domains":["api.example-data.com"]},"limits":{"per_day":"500.00","per_tx":"50.00"}}` |
| `payloadHash`           | `0xd229bb3374be43f80d0fea8a2f02e195283eb06457236fc56731c46b56747e9e`                                                                                                      |
| `issuedAt`, `expiresAt` | `1790000000`, `1790000600`                                                                                                                                                |
| EIP-712 digest          | `0xbfd8c5b17942dcae1c85c0acd0a41e02f23b17013e4d02b718daf3e5e06bc7fe` (derived)                                                                                            |
| Signature (owner key)   | `0xf837cf073e9f9566645f79f6fc73fa719cecb99599789db3fbd939648162d35f094233a113458cb13f8793a5e59a4fcef1010e7a6d0ad44bfc62a729f787d4e61b`                                    |

An authorization is valid for at most 15 minutes (`expiresAt - issuedAt ≤ 900`), must be signed by the org's `owner_address`, and is checked with a minute of clock leeway on `issuedAt`. The vectors file also has a [webhook signature](/guides/webhooks#test-vector) vector.
