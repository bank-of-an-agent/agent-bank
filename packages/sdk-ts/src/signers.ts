import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { OPERATION_HASH_SIGNING, type OwnerAuthorizationTypedData } from "@agentbank/core";
import { InvalidRequestError } from "./errors";

/**
 * Signer interfaces used by the SDK and helpers to create keys.
 *
 * The SDK never needs a raw private key: anything that can sign is enough.
 * A viem `LocalAccount` (e.g. from `privateKeyToAccount`) satisfies every
 * interface here; hardware wallets, KMS-backed signers and browser wallets
 * can be adapted with a few lines.
 *
 * Three keys, three jobs (see the architecture doc, "Identity, accounts and keys"):
 *
 * - **Session key** ({@link SessionSigner}): the agent's short-lived key. Signs
 *   every API request (RFC 9421, EIP-191) and the `user_op_hash` of payments,
 *   escrows and streams. Useless without the bank's co-signature.
 * - **Spend key** ({@link SpendSigner}): a per-agent EOA holding a small USDC
 *   float, used only to sign EIP-3009 `TransferWithAuthorization` for x402.
 * - **Owner key** ({@link OwnerSigner}): the principal's key. Signs EIP-712
 *   owner authorizations and owner operations. Agent Bank never holds it;
 *   never give it to an agent.
 *
 * @packageDocumentation
 */

/** A message accepted by {@link SessionSigner.signMessage}: a UTF-8 string or raw bytes. */
export type SignableMessage = string | { raw: Hex | Uint8Array };

/**
 * The agent's session key. Signs request signature bases (strings) and
 * operation hashes (`{ raw: hash }`), both as EIP-191 personal messages.
 */
export interface SessionSigner {
  readonly address: Address;
  signMessage(args: { message: SignableMessage }): Promise<Hex>;
}

/** Typed data accepted by {@link SpendSigner.signTypedData} (EIP-712). */
export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * The agent's x402 spend key (an EOA holding a small float). Signs EIP-3009
 * `TransferWithAuthorization` typed data only.
 */
export interface SpendSigner {
  readonly address: Address;
  signTypedData(typedData: TypedDataPayload): Promise<Hex>;
}

/**
 * The principal's owner key. Signs EIP-712 `OwnerAuthorization` messages and
 * owner operations (`user_op_hash` as an EIP-191 personal message over the
 * raw 32 bytes).
 *
 * @example Adapting a viem WalletClient (browser wallet)
 * ```ts
 * const owner: OwnerSigner = {
 *   address: account.address,
 *   signTypedData: (typedData) => walletClient.signTypedData({ account, ...typedData }),
 *   signMessage: ({ message }) => walletClient.signMessage({ account, message }),
 * };
 * ```
 */
export interface OwnerSigner {
  readonly address: Address;
  signTypedData(typedData: OwnerAuthorizationTypedData): Promise<Hex>;
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>;
}

/** A freshly generated secp256k1 key pair. */
export interface GeneratedKey {
  /** Checksummed address of the key. Register this with the API (it is public). */
  readonly address: Address;
  /**
   * The private key. Non-enumerable, so it does not show up in `console.log`
   * or `JSON.stringify` by accident. Store it in a {@link KeyStore}; never log it.
   */
  readonly privateKey: Hex;
  /** A viem account for the key: usable as a {@link SessionSigner}, {@link SpendSigner} or {@link OwnerSigner}. */
  readonly account: PrivateKeyAccount;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** True if `value` looks like a 0x-prefixed 32-byte hex private key. */
export function isPrivateKey(value: unknown): value is Hex {
  return typeof value === "string" && PRIVATE_KEY_RE.test(value);
}

/**
 * Build a viem account from a private key. Throws `invalid_request` (without
 * echoing the key) if the value is not a 32-byte hex string.
 */
export function signerFromPrivateKey(privateKey: string): PrivateKeyAccount {
  if (!isPrivateKey(privateKey)) {
    throw new InvalidRequestError("invalid_request", "Private key must be 0x-prefixed 32-byte hex");
  }
  return privateKeyToAccount(privateKey);
}

function wrapKey(privateKey: Hex): GeneratedKey {
  const account = privateKeyToAccount(privateKey);
  const key = { address: account.address, account } as GeneratedKey;
  Object.defineProperty(key, "privateKey", { value: privateKey, enumerable: false });
  return Object.freeze(key);
}

/**
 * Generate a new session key client-side (secp256k1, from the platform's
 * CSPRNG via `crypto.getRandomValues`). Register `address` with
 * `principal.grantSession(...)`; keep `privateKey` in a key store on the
 * agent's machine. Session keys are short-lived (default 24 h, max 7 days).
 */
export function generateSessionKey(): GeneratedKey {
  return wrapKey(generatePrivateKey());
}

/**
 * Generate a new x402 spend key (an EOA that holds the agent's small USDC
 * float, see ADR 0001). Pass `address` as `spend_key_address` when creating
 * the account.
 */
export function generateSpendKey(): GeneratedKey {
  return wrapKey(generatePrivateKey());
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The operation-hash signing scheme implemented by {@link signOperationHash}.
 * `satisfies` pins it to core's `OPERATION_HASH_SIGNING` at compile time.
 */
const IMPLEMENTED_OPERATION_SIGNING = "eip191-raw-bytes32" satisfies typeof OPERATION_HASH_SIGNING;

/**
 * Sign a 32-byte operation hash (`user_op_hash`) the way core specifies
 * (`OPERATION_HASH_SIGNING = "eip191-raw-bytes32"`): an EIP-191 personal
 * message over the **raw 32 bytes**, as the Smart Sessions / OwnableValidator
 * path verifies. Refuses anything that is not exactly 32 bytes of hex, so a
 * compromised API cannot make the key sign arbitrary text.
 */
export async function signOperationHash(
  signer: { signMessage(args: { message: { raw: Hex } }): Promise<Hex> },
  hash: string,
): Promise<Hex> {
  if (OPERATION_HASH_SIGNING !== IMPLEMENTED_OPERATION_SIGNING) {
    throw new InvalidRequestError(
      "invalid_request",
      `Unsupported operation signing scheme ${OPERATION_HASH_SIGNING}`,
    );
  }
  if (!BYTES32_RE.test(hash)) {
    throw new InvalidRequestError("invalid_request", "Refusing to sign: user_op_hash is not 32 bytes of hex");
  }
  return signer.signMessage({ message: { raw: hash as Hex } });
}
