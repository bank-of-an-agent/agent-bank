import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  pad,
  size,
  slice,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { safe7579Abi, safe7579LaunchpadAbi } from "./abis/account";
import type { Call } from "./types";

/**
 * ERC-7579 execution encoding as used by the Safe7579 adapter and checked by Smart Sessions.
 *
 * Execution mode (bytes32): callType (1) | execType (1) | unused (4) | modeSelector (4) | payload (22).
 * Agent Bank only ever produces default-exec single and batch calls; Smart Sessions rejects every
 * other mode for session operations.
 */

/** ERC-7579 single call type. */
export const CALLTYPE_SINGLE = 0x00;
/** ERC-7579 batch call type. */
export const CALLTYPE_BATCH = 0x01;
/** ERC-7579 static call type (never accepted). */
export const CALLTYPE_STATIC = 0xfe;
/** ERC-7579 delegatecall type (never accepted). */
export const CALLTYPE_DELEGATECALL = 0xff;
/** ERC-7579 default exec type: revert on the first failing call. */
export const EXECTYPE_DEFAULT = 0x00;
/** ERC-7579 try exec type (rejected for session operations). */
export const EXECTYPE_TRY = 0x01;

/** Default single-call mode (revert on failure). */
export const MODE_SINGLE_DEFAULT: Hex = pad("0x00", { size: 32 });
/** Default batch mode (revert on failure). */
export const MODE_BATCH_DEFAULT: Hex = pad("0x01", { size: 32, dir: "right" });

const EXECUTION_BATCH = [
  {
    name: "executions",
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;

/** Encode `execute(mode, executionCalldata)` for one or more calls (single mode for one call). */
export function encodeExecute(calls: readonly Call[]): Hex {
  if (calls.length === 0) throw new RangeError("encodeExecute: at least one call is required");
  if (calls.length === 1) {
    const [call] = calls as [Call];
    return encodeFunctionData({
      abi: safe7579Abi,
      functionName: "execute",
      args: [MODE_SINGLE_DEFAULT, concatHex([call.to, toHex(call.value ?? 0n, { size: 32 }), call.data])],
    });
  }
  return encodeFunctionData({
    abi: safe7579Abi,
    functionName: "execute",
    args: [
      MODE_BATCH_DEFAULT,
      encodeAbiParameters(EXECUTION_BATCH, [
        calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data })),
      ]),
    ],
  });
}

/** A decoded execution mode. */
export interface ExecutionMode {
  callType: number;
  execType: number;
  modeSelector: Hex;
  payload: Hex;
}

/** Split an ERC-7579 execution mode word into its fields. */
export function decodeExecutionMode(mode: Hex): ExecutionMode {
  return {
    callType: Number(BigInt(slice(mode, 0, 1))),
    execType: Number(BigInt(slice(mode, 1, 2))),
    modeSelector: slice(mode, 6, 10),
    payload: slice(mode, 10, 32),
  };
}

/** Result of decoding account calldata. `ok: false` carries why it is not a plain execution. */
export type DecodedExecution =
  | { ok: true; mode: ExecutionMode; calls: Required<Call>[]; deploys: boolean }
  | { ok: false; reason: string };

/**
 * Decode the calls an account executes from user-operation calldata. Accepts
 * `execute(mode, data)` with default-exec single or batch mode, and the Safe7579 launchpad's
 * `setupSafe(initData)` wrapper used by the deploying operation (its inner `callData` must itself be
 * such an `execute`). Everything else (delegatecall, try-mode, static, other selectors) is rejected.
 */
export function decodeExecute(callData: Hex): DecodedExecution {
  let deploys = false;
  let data = callData;
  try {
    const setup = decodeFunctionData({ abi: safe7579LaunchpadAbi, data });
    if (setup.functionName === "setupSafe") {
      deploys = true;
      data = setup.args[0].callData;
    }
  } catch {
    // not a launchpad call
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: safe7579Abi, data });
  } catch {
    return { ok: false, reason: "calldata is not an ERC-7579 execute call" };
  }
  if (decoded.functionName !== "execute") {
    return { ok: false, reason: `unsupported account function ${decoded.functionName}` };
  }
  const [modeHex, executionCalldata] = decoded.args as readonly [Hex, Hex];
  const mode = decodeExecutionMode(modeHex);
  if (mode.execType !== EXECTYPE_DEFAULT) return { ok: false, reason: "only default exec type is supported" };
  if (mode.modeSelector !== "0x00000000") return { ok: false, reason: "mode selectors are not supported" };
  try {
    if (mode.callType === CALLTYPE_SINGLE) {
      if (size(executionCalldata) < 52) return { ok: false, reason: "single execution is too short" };
      const to = getAddress(slice(executionCalldata, 0, 20));
      const value = BigInt(slice(executionCalldata, 20, 52));
      const callDataInner = size(executionCalldata) > 52 ? slice(executionCalldata, 52) : "0x";
      return { ok: true, mode, calls: [{ to, value, data: callDataInner }], deploys };
    }
    if (mode.callType === CALLTYPE_BATCH) {
      const [executions] = decodeAbiParameters(EXECUTION_BATCH, executionCalldata);
      if (executions.length === 0) return { ok: false, reason: "empty batch" };
      return {
        ok: true,
        mode,
        calls: executions.map((e) => ({ to: getAddress(e.target), value: e.value, data: e.callData })),
        deploys,
      };
    }
  } catch {
    return { ok: false, reason: "malformed execution calldata" };
  }
  return { ok: false, reason: `unsupported call type 0x${mode.callType.toString(16).padStart(2, "0")}` };
}

/**
 * ERC-4337 nonce key that routes a Safe7579 user operation to `validator`: the validator address
 * in the top 20 bytes of the 24-byte key, followed by a 4-byte lane (for parallel nonces).
 */
export function validatorNonceKey(validator: Address, lane = 0): bigint {
  if (!Number.isInteger(lane) || lane < 0 || lane > 0xffff_ffff) throw new RangeError("lane must be uint32");
  return (BigInt(validator) << 32n) | BigInt(lane);
}

/** Split a full 256-bit nonce into the validator it targets, its lane and its sequence. */
export function decodeNonce(nonce: bigint): {
  validator: Address;
  lane: number;
  key: bigint;
  sequence: bigint;
} {
  const key = nonce >> 64n;
  const sequence = nonce & ((1n << 64n) - 1n);
  const validator = getAddress(pad(toHex(key >> 32n), { size: 20 }));
  const lane = Number(key & 0xffff_ffffn);
  return { validator, lane, key, sequence };
}
