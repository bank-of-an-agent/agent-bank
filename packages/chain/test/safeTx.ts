import {
  concatHex,
  encodeFunctionData,
  hashTypedData,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { SAFE_TX_TYPES, safeAbi } from "../src";

/** A Safe-native transaction (operation CALL, no gas refund). */
export interface SafeTxInput {
  chainId: number;
  safe: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  /** The Safe's current `nonce()`. */
  nonce: bigint;
}

function safeTxMessage(input: SafeTxInput) {
  return {
    to: input.to,
    value: input.value ?? 0n,
    data: input.data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: input.nonce,
  } as const;
}

/** EIP-712 `SafeTx` hash (`Safe.getTransactionHash`). */
export function safeTxHash(input: SafeTxInput): Hex {
  return hashTypedData({
    domain: { chainId: input.chainId, verifyingContract: input.safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: safeTxMessage(input),
  });
}

/**
 * `execTransaction` calldata for a Safe-native transaction signed by `signers` (EIP-712, v 27/28,
 * signatures ordered by signer address as the Safe requires). Test helper: the owner exit tool owns
 * the production version of this path.
 */
export async function safeExecTransactionData(
  input: SafeTxInput,
  signers: PrivateKeyAccount[],
): Promise<Hex> {
  const message = safeTxMessage(input);
  const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const signatures = concatHex(
    await Promise.all(
      sorted.map((s) =>
        s.signTypedData({
          domain: { chainId: input.chainId, verifyingContract: input.safe },
          types: SAFE_TX_TYPES,
          primaryType: "SafeTx",
          message,
        }),
      ),
    ),
  );
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [
      message.to,
      message.value,
      message.data,
      message.operation,
      message.safeTxGas,
      message.baseGas,
      message.gasPrice,
      message.gasToken,
      message.refundReceiver,
      signatures,
    ],
  });
}
