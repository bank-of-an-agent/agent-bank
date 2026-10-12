import type { Address, Hex } from "viem";

export type SignerKind = "local" | "kms";

/**
 * The co-signer's key. It signs exactly one thing: a 32-byte user operation
 * hash, as an EIP-191 personal message over the raw bytes (core
 * `OPERATION_HASH_SIGNING`; chain `signOperationHash`), the format the
 * account's 2-of-2 OwnableValidator (session key + co-signer) verifies.
 * The signature is 65 bytes `r || s || v` with low `s` and `v ∈ {27, 28}`.
 *
 * A co-signer signature alone can never move funds: on-chain it is only
 * valid together with a live, in-scope session-key signature.
 */
export interface CosignerSigner {
  readonly kind: SignerKind;
  readonly address: Address;
  signHash(hash: Hex): Promise<Hex>;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export function assertBytes32(hash: string): asserts hash is Hex {
  if (!BYTES32.test(hash)) throw new TypeError("signHash expects a 32-byte hex hash");
}
