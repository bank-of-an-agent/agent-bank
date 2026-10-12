import { AgentBankError } from "@agentbank/core";
import {
  concatHex,
  hexToNumber,
  isHex,
  recoverMessageAddress,
  size,
  slice,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { SMART_SESSION_MODE } from "./abis";

/**
 * Operation signatures.
 *
 * Every signer (owner, session key, co-signer) produces the same thing: an EIP-191 personal-sign
 * signature over the 32 raw bytes of the ERC-4337 user operation hash
 * (`"\x19Ethereum Signed Message:\n32" ‖ userOpHash`), with v = 27/28. The encoders adapt it to what
 * each on-chain verifier expects:
 *
 * - owner path: `OwnableValidator.validateUserOp` prefixes the hash itself, so the 65-byte
 *   signature is used as is;
 * - session path: Smart Sessions passes the *raw* hash to `OwnableValidator.validateSignatureWithData`,
 *   whose `CheckSignatures` applies the EIP-191 prefix only when v > 30, so each signature's v is
 *   raised by 4 and the two are concatenated after the USE-mode header `0x00 ‖ permissionId`.
 */

const SIG_LENGTH = 65;

/** EIP-191 personal-sign the raw 32 bytes of an operation hash. */
export async function signOperationHash(account: LocalAccount, hash: Hex): Promise<Hex> {
  assertHash(hash);
  return account.signMessage({ message: { raw: hash } });
}

/** Address that produced an EIP-191 signature over an operation hash (accepts v = 0/1/27/28/31/32). */
export async function recoverOperationSigner(hash: Hex, signature: Hex): Promise<Address> {
  assertHash(hash);
  return recoverMessageAddress({ message: { raw: hash }, signature: withV(signature, 0) });
}

/** Owner-path `userOp.signature`: the owner's 65-byte EIP-191 signature, v normalised to 27/28. */
export function encodeOwnerSignature(signature: Hex): Hex {
  return withV(signature, 0);
}

/**
 * Session-path `userOp.signature` (Smart Sessions USE mode, OwnableValidator 2-of-2):
 * `0x00 ‖ permissionId ‖ sig(sessionKey) ‖ sig(cosigner)`, each v raised to 31/32. Signature order
 * does not matter on-chain (signers are sorted before matching).
 */
export function encodeSessionSignature(input: {
  permissionId: Hex;
  sessionSignature: Hex;
  cosignerSignature: Hex;
}): Hex {
  if (!isHex(input.permissionId) || size(input.permissionId) !== 32) {
    throw new AgentBankError("invalid_request", "permissionId must be 32 bytes");
  }
  return concatHex([
    toHex(SMART_SESSION_MODE.USE, { size: 1 }),
    input.permissionId,
    withV(input.sessionSignature, 4),
    withV(input.cosignerSignature, 4),
  ]);
}

/** Split a USE-mode session signature. Returns `null` when it is not one. */
export function decodeSessionSignature(signature: Hex): { permissionId: Hex; signatures: Hex[] } | null {
  if (!isHex(signature) || size(signature) < 33) return null;
  if (hexToNumber(slice(signature, 0, 1)) !== SMART_SESSION_MODE.USE) return null;
  const permissionId = slice(signature, 1, 33);
  const rest = size(signature) > 33 ? slice(signature, 33) : "0x";
  if (size(rest) % SIG_LENGTH !== 0) return null;
  const signatures: Hex[] = [];
  for (let i = 0; i < size(rest); i += SIG_LENGTH) signatures.push(slice(rest, i, i + SIG_LENGTH));
  return { permissionId, signatures };
}

/**
 * A syntactically valid ECDSA signature that recovers to an arbitrary address, for gas estimation.
 * Validation fails with it (signature failure, not a revert), after the same work as a real one.
 */
export const STUB_ECDSA_SIGNATURE: Hex =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";

/** Stub owner signature (same length as a real one). */
export function stubOwnerSignature(): Hex {
  return STUB_ECDSA_SIGNATURE;
}

/** Stub session signature (same length as a real one). */
export function stubSessionSignature(permissionId: Hex): Hex {
  return encodeSessionSignature({
    permissionId,
    sessionSignature: STUB_ECDSA_SIGNATURE,
    cosignerSignature: STUB_ECDSA_SIGNATURE,
  });
}

function assertHash(hash: Hex): void {
  if (!isHex(hash) || size(hash) !== 32) throw new AgentBankError("invalid_request", "hash must be 32 bytes");
}

/** Return the 65-byte signature with v = 27/28 + `offset`; rejects other lengths and v values. */
function withV(signature: Hex, offset: 0 | 4): Hex {
  if (!isHex(signature) || size(signature) !== SIG_LENGTH) {
    throw new AgentBankError("signature_invalid", "expected a 65-byte ECDSA signature");
  }
  let v = hexToNumber(slice(signature, 64, 65));
  if (v === 0 || v === 1) v += 27;
  else if (v === 31 || v === 32) v -= 4;
  if (v !== 27 && v !== 28) throw new AgentBankError("signature_invalid", "unsupported signature v value");
  return concatHex([slice(signature, 0, 64), toHex(v + offset, { size: 1 })]);
}
