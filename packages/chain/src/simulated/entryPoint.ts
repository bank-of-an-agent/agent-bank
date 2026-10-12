import { decodeFunctionData, getAddress, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import { accountFactoryArgs, accountInitHash, accountInitData } from "../account";
import { entryPointAbi, safe7579LaunchpadAbi } from "../abis";
import { decodeNonce } from "../erc7579";
import type { UserOperationV07 } from "../json";
import type { AccountDeployment, ChainContracts } from "../types";
import type { SimAccounts } from "./accounts";
import { JMap } from "./journal";
import { SessionValidationError, type SimSmartSessions, type Window } from "./smartSessions";
import { emitLog, eventOf, key, SimRevert, type ExecContext } from "./vm";
import type { Journal } from "./journal";

const USER_OPERATION_EVENT = eventOf(entryPointAbi, "UserOperationEvent");
const ACCOUNT_DEPLOYED = eventOf(entryPointAbi, "AccountDeployed");
const USER_OPERATION_REVERT_REASON = eventOf(entryPointAbi, "UserOperationRevertReason");

/** Error codes a rejected operation maps to (see `@agentbank/core` errors). */
export type RejectionCode =
  | "signature_invalid"
  | "session_expired"
  | "session_revoked"
  | "policy_denied"
  | "invalid_state"
  | "invalid_request";

/** The bundler/EntryPoint rejected an operation during validation: it is never included. */
export class OperationRejected extends Error {
  constructor(
    readonly reason: string,
    readonly code: RejectionCode,
  ) {
    super(reason);
    this.name = "OperationRejected";
  }
}

/** Result of the execution phase of a user operation. */
export interface UserOpOutcome {
  success: boolean;
  revertReason: string | null;
  actualGasUsed: bigint;
  actualGasCost: bigint;
}

/** Nominal gas accounting (the simulator does not meter gas). */
function nominalGas(callData: Hex): bigint {
  return 60_000n + BigInt((callData.length - 2) / 2) * 16n;
}

/** ERC-4337 v0.7 EntryPoint semantics for Safe7579 accounts. */
export class SimEntryPoint {
  private readonly nonces: JMap<string, bigint>;

  constructor(
    journal: Journal,
    private readonly contracts: ChainContracts,
    private readonly accounts: SimAccounts,
    private readonly sessions: SimSmartSessions,
    /** Resolves the deployment parameters registered for a counterfactual address. */
    private readonly deploymentOf: (address: Address) => AccountDeployment | undefined,
  ) {
    this.nonces = new JMap(journal);
  }

  /** `EntryPoint.getNonce(sender, key)`. */
  getNonce(sender: Address, nonceKey: bigint): bigint {
    return (nonceKey << 64n) | (this.nonces.get(key(sender, nonceKey)) ?? 0n);
  }

  /**
   * Validation phase. Throws {@link OperationRejected} if the operation would be rejected (nothing it
   * did may persist: callers revert the journal). On success the validation-phase effects (nonce,
   * account creation, Smart Sessions policy counters) are in the journal. `estimate` ignores signature
   * failures, as bundlers do when estimating gas with a stub signature.
   */
  validate(
    ctx: ExecContext,
    op: UserOperationV07,
    userOpHash: Hex,
    options: { estimate?: boolean } = {},
  ): { deployed: boolean } {
    const sender = getAddress(op.sender);
    let record = this.accounts.get(sender);
    let deployed = false;

    if (op.factory) {
      if (record) throw new OperationRejected("AA10 sender already constructed", "invalid_state");
      const deployment = this.deploymentOf(sender);
      if (!deployment)
        throw new OperationRejected("AA13 initCode failed (unknown deployment)", "invalid_request");
      const expected = accountFactoryArgs(deployment, this.contracts);
      if (
        getAddress(op.factory) !== expected.factory ||
        (op.factoryData ?? "0x").toLowerCase() !== expected.factoryData.toLowerCase()
      ) {
        throw new OperationRejected("AA14 initCode must return sender", "invalid_request");
      }
      record = this.accounts.createFromLaunchpad(sender, deployment);
      deployed = true;
      emitLog(ctx, this.contracts.entryPoint, ACCOUNT_DEPLOYED, {
        userOpHash,
        sender,
        factory: op.factory,
        paymaster: op.paymaster ?? zeroAddress,
      });
    } else if (!record) {
      throw new OperationRejected("AA20 account not deployed", "invalid_state");
    }

    if (record.stage === "launchpad") {
      let setup;
      try {
        setup = decodeFunctionData({ abi: safe7579LaunchpadAbi, data: op.callData });
      } catch {
        throw new OperationRejected(
          "AA23 reverted: Safe7579Launchpad InvalidUserOperationData",
          "invalid_request",
        );
      }
      if (setup.functionName !== "setupSafe") {
        throw new OperationRejected(
          "AA23 reverted: Safe7579Launchpad InvalidUserOperationData",
          "invalid_request",
        );
      }
      const { callData: _inner, ...init } = setup.args[0];
      if (
        accountInitHash(init as ReturnType<typeof accountInitData>) !==
        accountInitHash(accountInitData(record.deployment, this.contracts))
      ) {
        throw new OperationRejected("AA23 reverted: Safe7579Launchpad InvalidInitHash", "invalid_request");
      }
      if (!deployed) {
        // The launchpad re-initialises validators in validateUserOp; they already are: stuck account.
        throw new OperationRejected(
          "AA23 reverted: validators already initialized (setup reverted earlier)",
          "invalid_state",
        );
      }
    }

    const { validator, key: nonceKey, sequence } = decodeNonce(op.nonce);
    if (!this.accounts.isValidatorInstalled(record, validator)) {
      throw new OperationRejected(
        `AA24 signature error: validator ${validator} is not installed (Safe-native signatures are not simulated)`,
        "signature_invalid",
      );
    }
    let sigFailed: boolean;
    let window: Window = { validAfter: 0, validUntil: 0 };
    if (validator === getAddress(this.contracts.ownableValidator)) {
      // Estimation tolerates signature failures anyway: skip the recovery.
      sigFailed = options.estimate ? false : !this.accounts.validateOwnerOp(record, userOpHash, op.signature);
    } else if (validator === getAddress(this.contracts.smartSessions)) {
      if (record.stage !== "ready")
        throw new OperationRejected("AA23 reverted: Smart Sessions not initialized", "invalid_state");
      try {
        const result = this.sessions.validateUserOp(sender, op, userOpHash, {
          skipSignature: options.estimate === true,
        });
        sigFailed = result.sigFailed;
        window = result.window;
      } catch (error) {
        if (error instanceof SessionValidationError)
          throw new OperationRejected(`AA23 reverted: ${error.reason}`, error.code);
        if (error instanceof SimRevert)
          throw new OperationRejected(`AA23 reverted: ${error.reason}`, "invalid_request");
        throw error;
      }
    } else {
      throw new OperationRejected(
        `AA24 signature error: validator ${validator} is not simulated`,
        "signature_invalid",
      );
    }

    const current = this.nonces.get(key(sender, nonceKey)) ?? 0n;
    if (sequence !== current) throw new OperationRejected("AA25 invalid account nonce", "invalid_state");
    this.nonces.set(key(sender, nonceKey), current + 1n);

    // Gas estimation runs with a stub signature: bundlers tolerate the signature failure.
    if (sigFailed && !options.estimate)
      throw new OperationRejected("AA24 signature error", "signature_invalid");
    const outOfRange =
      (window.validUntil !== 0 && ctx.timestamp > window.validUntil) || ctx.timestamp < window.validAfter;
    if (outOfRange && !options.estimate) {
      throw new OperationRejected("AA22 expired or not due", "session_expired");
    }
    return { deployed };
  }

  /** Execution phase: run the account call; a revert is caught and reported (the operation is still included). */
  execute(ctx: ExecContext, op: UserOperationV07, userOpHash: Hex): UserOpOutcome {
    const sender = getAddress(op.sender);
    const record = this.accounts.get(sender);
    const mark = ctx.journal.mark();
    let revertReason: string | null = null;
    try {
      if (record?.stage === "launchpad") {
        const setup = decodeFunctionData({ abi: safe7579LaunchpadAbi, data: op.callData });
        this.accounts.completeSetup(sender);
        this.accounts.execute(ctx, sender, (setup.args[0] as { callData: Hex }).callData);
      } else {
        this.accounts.execute(ctx, sender, op.callData);
      }
    } catch (error) {
      if (!(error instanceof SimRevert)) throw error;
      ctx.journal.revertTo(mark);
      revertReason = error.reason;
    }
    const actualGasUsed = nominalGas(op.callData);
    const actualGasCost = actualGasUsed * op.maxFeePerGas;
    if (revertReason !== null) {
      emitLog(ctx, this.contracts.entryPoint, USER_OPERATION_REVERT_REASON, {
        userOpHash,
        sender,
        nonce: op.nonce,
        revertReason: stringToHex(revertReason),
      });
    }
    emitLog(ctx, this.contracts.entryPoint, USER_OPERATION_EVENT, {
      userOpHash,
      sender,
      paymaster: op.paymaster ?? zeroAddress,
      nonce: op.nonce,
      success: revertReason === null,
      actualGasCost,
      actualGasUsed,
    });
    return { success: revertReason === null, revertReason, actualGasUsed, actualGasCost };
  }
}
