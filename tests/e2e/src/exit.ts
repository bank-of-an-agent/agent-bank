import {
  escrowRefundCall,
  floatSweepCall,
  safeAbi,
  SAFE_TX_TYPES,
  streamCancelCall,
  transferCall,
  vaultWithdrawCall,
  type Call,
} from "@agentbank/chain";
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import type { Stack } from "./stack";

/**
 * The owner's exit path, re-implemented against the simulated chain with **only the owner key
 * and the chain** — no API, co-signer, facilitator or indexer. It mirrors the open-source exit
 * tool (`bank-of-an-agent/exit-tool`, whose own Anvil shutdown drill is the reference): the
 * Safe-native `execTransaction`, which accepts the owner's signature directly and bypasses the
 * ERC-7579 modules and the policy hook, plus the permissionless exit paths of the escrow, stream
 * and vault contracts and the spend-key float's provisioning permit.
 */

interface SafeTx {
  to: Address;
  data: Hex;
  value?: bigint;
  nonce: bigint;
}

function safeTxMessage(tx: SafeTx) {
  return {
    to: tx.to,
    value: tx.value ?? 0n,
    data: tx.data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: tx.nonce,
  } as const;
}

/** `execTransaction` calldata signed by the owner (EIP-712 SafeTx, v 27/28). */
async function execTransactionData(
  chainId: number,
  safe: Address,
  tx: SafeTx,
  owner: PrivateKeyAccount,
): Promise<Hex> {
  const message = safeTxMessage(tx);
  const signature = await owner.signTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message,
  });
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
      concatHex([signature]),
    ],
  });
}

export interface ExitPositions {
  escrow?: { contract: Address; onchainId: bigint };
  stream?: { contract: Address; onchainId: bigint };
  vault?: { contract: Address; onchainId: bigint; amount: bigint };
  spendKey?: Address;
}

export interface ExitResult {
  destination: Address;
  recovered: bigint;
  steps: { step: string; detail: string }[];
}

/**
 * Recover everything to `destination` using only `owner` and the chain. The account's own calls
 * (stream cancel, float sweep via `transferFrom`, the final USDC sweep) go through the Safe's
 * `execTransaction`; the permissionless paths (expired-escrow refund, unlocked-vault withdrawal)
 * are relayed by the owner as a plain transaction.
 */
export async function ownerExit(
  stack: Stack,
  owner: PrivateKeyAccount,
  account: Address,
  destination: Address,
  positions: ExitPositions,
): Promise<ExitResult> {
  const chainId = stack.chainId;
  const usdc = getAddress(stack.sim.contracts.usdc);
  const steps: { step: string; detail: string }[] = [];
  const safeNonce = (): bigint => stack.sim.account(account)?.safeNonce ?? 0n;

  const sendOwnerTx = (to: Address, data: Hex): Hex =>
    stack.sim.sendTransaction({ from: getAddress(owner.address), to, data });
  const exec = async (call: Call): Promise<Hex> => {
    const data = await execTransactionData(
      chainId,
      account,
      { to: getAddress(call.to), data: call.data, nonce: safeNonce() },
      owner,
    );
    const hash = sendOwnerTx(account, data);
    const tx = stack.sim.transaction(hash);
    if (!tx?.success) throw new Error(`execTransaction reverted: ${tx?.revertReason ?? "unknown"}`);
    return hash;
  };

  // 1. Refund the expired escrow (permissionless after expiry); funds return to the account.
  if (positions.escrow) {
    sendOwnerTx(
      positions.escrow.contract,
      escrowRefundCall({ escrow: positions.escrow.contract, escrowId: positions.escrow.onchainId }).data,
    );
    steps.push({
      step: "refund-escrow",
      detail: `escrow #${positions.escrow.onchainId} refunded to the account`,
    });
  }

  // 2. Cancel the stream (payer-only): the account calls it through execTransaction.
  if (positions.stream) {
    await exec(
      streamCancelCall({ streams: positions.stream.contract, streamId: positions.stream.onchainId }),
    );
    steps.push({
      step: "cancel-stream",
      detail: `stream #${positions.stream.onchainId} canceled; remainder refunded`,
    });
  }

  // 3. Withdraw the unlocked vault (permissionless after unlock); funds return to the account.
  if (positions.vault) {
    sendOwnerTx(
      positions.vault.contract,
      vaultWithdrawCall({
        vaults: positions.vault.contract,
        vaultId: positions.vault.onchainId,
        amount: positions.vault.amount,
      }).data,
    );
    steps.push({
      step: "withdraw-vault",
      detail: `vault #${positions.vault.onchainId} returned to the account`,
    });
  }

  // 4. Sweep the spend-key float back with the provisioning permit's allowance (account pulls it).
  if (positions.spendKey) {
    const floatBal = stack.sim.balanceOf(getAddress(positions.spendKey));
    if (floatBal > 0n) {
      await exec(floatSweepCall(usdc, getAddress(positions.spendKey), account, floatBal));
      steps.push({ step: "sweep-float", detail: `swept ${floatBal} from the spend key into the account` });
    }
  }

  // 5. Sweep the account's whole USDC balance to the owner's destination (bypassing the hook).
  const accountBal = stack.sim.balanceOf(account);
  if (accountBal > 0n) {
    await exec(transferCall({ token: usdc, to: destination, amount: accountBal }));
    steps.push({ step: "withdraw-usdc", detail: `transferred ${accountBal} to ${destination}` });
  }

  return { destination, recovered: stack.sim.balanceOf(destination), steps };
}
