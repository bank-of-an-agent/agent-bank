import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  hashTypedData,
  size,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { accountInitData } from "../account";
import { MODULE_TYPE, ownableValidatorConfigParams, safe7579Abi } from "../abis";
import { MODULE_REGISTRY, RHINESTONE_ATTESTER } from "../constants";
import {
  CALLTYPE_BATCH,
  CALLTYPE_SINGLE,
  decodeExecutionMode,
  EXECTYPE_DEFAULT,
  EXECTYPE_TRY,
} from "../erc7579";
import type { AccountDeployment, ChainContracts } from "../types";
import { ecrecover, ethSignedMessageHash, splitSignature } from "./ecdsa";
import { JMap } from "./journal";
import type { SimPolicyHook } from "./policyHook";
import { checkSignatures } from "./smartSessions";
import { check, key, revert, SimRevert, type ExecContext } from "./vm";
import type { World } from "./world";

/** A simulated Safe7579 account. */
export interface SimAccountRecord {
  address: Address;
  deployment: AccountDeployment;
  /** `launchpad`: proxy created and validators initialised, `setupSafe` not executed yet. */
  stage: "launchpad" | "ready";
  safeOwners: Address[];
  safeThreshold: number;
  /** Installed ERC-7579 validators. */
  validators: Address[];
  /** OwnableValidator storage for this account (owner path). */
  ownerValidator: { threshold: number; owners: Address[] };
  /** ERC-7484 registry consulted for module installs (zero address = none). */
  registry: Address;
  attesters: Address[];
  attestersThreshold: number;
  globalHook: Address;
  executors: Address[];
}

/** Implemented elsewhere: install/uninstall callbacks of Agent Bank executor modules. */
export interface ExecutorModule {
  onInstall(ctx: ExecContext, account: Address, data: Hex): void;
  onUninstall(ctx: ExecContext, account: Address): void;
}

/**
 * Accounts as the deployed Safe v1.4.1 + Safe7579 v1.0.0 + launchpad behave for Agent Bank:
 * launchpad deployment, module management (with ERC-7484 registry checks), global hook around
 * `execute` / `executeFromExecutor`, the OwnableValidator owner path and ERC-1271.
 */
export class SimAccounts {
  private readonly accounts: JMap<string, SimAccountRecord>;
  /** ERC-7484 registry attestations: (attester, module). */
  readonly attestations: JMap<string, true>;

  constructor(
    private readonly world: World,
    private readonly contracts: ChainContracts,
    private readonly hook: SimPolicyHook,
    private readonly executorModules: Record<string, ExecutorModule>,
  ) {
    this.accounts = new JMap(world.journal);
    this.attestations = new JMap(world.journal);
  }

  /** Pre-attest the modules Rhinestone's attester has attested on Base Sepolia. */
  seedRegistry(): void {
    for (const module of [this.contracts.smartSessions, this.contracts.ownableValidator]) {
      this.attestations.set(key(RHINESTONE_ATTESTER, module), true);
    }
  }

  get(address: Address): SimAccountRecord | undefined {
    return this.accounts.get(key(address));
  }

  private save(record: SimAccountRecord): void {
    this.accounts.set(key(record.address), record);
  }

  /** Validation phase of a deploying operation: create the proxy and initialise its validators. */
  createFromLaunchpad(address: Address, deployment: AccountDeployment): SimAccountRecord {
    if (this.get(address)) revert("AA10 sender already constructed");
    const init = accountInitData(deployment, this.contracts);
    let ownerValidator = { threshold: 0, owners: [] as Address[] };
    for (const v of init.validators) {
      if (getAddress(v.module) === getAddress(this.contracts.ownableValidator)) {
        const [threshold, owners] = decodeAbiParameters(ownableValidatorConfigParams, v.initData);
        ownerValidator = { threshold: Number(threshold), owners: owners.map((o) => getAddress(o)) };
      }
    }
    const record: SimAccountRecord = {
      address: getAddress(address),
      deployment,
      stage: "launchpad",
      safeOwners: [],
      safeThreshold: 0,
      validators: init.validators.map((v) => getAddress(v.module)),
      ownerValidator,
      registry: zeroAddress,
      attesters: [],
      attestersThreshold: 0,
      globalHook: zeroAddress,
      executors: [],
    };
    this.save(record);
    return record;
  }

  /** Execution phase of the deploying operation (`setupSafe`): Safe setup and `initSafe7579`. */
  completeSetup(address: Address): void {
    const record = this.get(address);
    if (!record || record.stage !== "launchpad") revert("Safe7579Launchpad: not a launchpad proxy");
    const init = accountInitData(record.deployment, this.contracts);
    this.save({
      ...record,
      stage: "ready",
      safeOwners: [...init.owners],
      safeThreshold: Number(init.threshold),
    });
    this.configureRegistry(
      address,
      MODULE_REGISTRY,
      this.contracts.attesters,
      this.contracts.attestersThreshold,
    );
  }

  private configureRegistry(
    account: Address,
    registry: Address,
    attesters: readonly Address[],
    threshold: number,
  ): void {
    const record = this.get(account) as SimAccountRecord;
    if (registry !== zeroAddress) {
      // Registry.trustAttesters
      if (attesters.length === 0 || attesters.length > 255) revert("InvalidTrustedAttesterInput()");
      for (let i = 1; i < attesters.length; i++) {
        if (BigInt(attesters[i - 1] as Address) >= BigInt(attesters[i] as Address))
          revert("InvalidTrustedAttesterInput()");
      }
      if (attesters[0] === zeroAddress) revert("InvalidTrustedAttesterInput()");
      if (threshold > attesters.length) revert("InvalidThreshold()");
    }
    this.save({
      ...record,
      registry: getAddress(registry),
      attesters: attesters.map((a) => getAddress(a)),
      attestersThreshold: threshold,
    });
  }

  /** `withRegistry(module, type)`: the registry's `checkForAccount`, when the account has one. */
  private checkRegistry(record: SimAccountRecord, module: Address): void {
    if (record.registry === zeroAddress) return;
    if (record.attesters.length === 0 || record.attestersThreshold === 0) revert("NoTrustedAttestersFound()");
    const attested = record.attesters.filter((a) => this.attestations.has(key(a, module))).length;
    if (attested < record.attestersThreshold) revert(`InsufficientAttestations(${module})`);
  }

  isValidatorInstalled(record: SimAccountRecord, validator: Address): boolean {
    return record.validators.includes(getAddress(validator));
  }

  /** OwnableValidator `validateUserOp` for the owner path (EIP-191 over the user operation hash). */
  validateOwnerOp(record: SimAccountRecord, userOpHash: Hex, signature: Hex): boolean {
    const { threshold, owners } = record.ownerValidator;
    return checkSignatures(ethSignedMessageHash(userOpHash), signature, owners, threshold);
  }

  /** Safe `checkSignatures(dataHash, signatures)` for EOA owners (v 27/28 raw, v > 30 EIP-191). */
  private safeCheckSignatures(record: SimAccountRecord, dataHash: Hex, signatures: Hex): boolean {
    const threshold = record.safeThreshold;
    if (threshold === 0 || size(signatures) < threshold * 65) return false;
    let last = 0n;
    for (let i = 0; i < threshold; i++) {
      const parts = splitSignature(slice(signatures, i * 65, i * 65 + 65));
      if (!parts || parts.v === 0 || parts.v === 1) return false;
      const signer =
        parts.v > 30
          ? ecrecover(ethSignedMessageHash(dataHash), parts.v - 4, parts.r, parts.s)
          : ecrecover(dataHash, parts.v, parts.r, parts.s);
      if (!signer || BigInt(signer) <= last || !record.safeOwners.includes(signer)) return false;
      last = BigInt(signer);
    }
    return true;
  }

  /** Safe `SafeMessage` hash of a 32-byte message hash. */
  safeMessageHash(account: Address, hash: Hex): Hex {
    return hashTypedData({
      domain: { chainId: this.world.chainId, verifyingContract: account },
      types: { SafeMessage: [{ name: "message", type: "bytes" }] },
      primaryType: "SafeMessage",
      message: { message: hash },
    });
  }

  /**
   * Safe7579 `isValidSignature(hash, data)`: `data = validator ‖ signature`. Validator zero (or not
   * installed): Safe owner signatures over the `SafeMessage`; OwnableValidator: its owners over the
   * raw hash. Smart Sessions grants no ERC-1271 rights to Agent Bank sessions.
   */
  isValidSignature(record: SimAccountRecord, hash: Hex, data: Hex): boolean {
    if (record.stage !== "ready" || size(data) < 20) return false;
    const validator = getAddress(slice(data, 0, 20));
    const signature = size(data) > 20 ? slice(data, 20) : "0x";
    if (validator === zeroAddress || !this.isValidatorInstalled(record, validator)) {
      return this.safeCheckSignatures(record, this.safeMessageHash(record.address, hash), signature);
    }
    if (validator === getAddress(this.contracts.ownableValidator)) {
      const { threshold, owners } = record.ownerValidator;
      return checkSignatures(hash, signature, owners, threshold);
    }
    return false;
  }

  /** Calls from the account to itself (`execute` targeting the account): module management. */
  selfCall(ctx: ExecContext, account: Address, data: Hex): Hex {
    const record = this.get(account);
    if (!record || record.stage !== "ready") revert("account not ready");
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: safe7579Abi, data });
    } catch {
      revert("simulator: unsupported account self-call");
    }
    const a = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "setRegistry":
        this.configureRegistry(account, getAddress(a[0] as Address), a[1] as Address[], Number(a[2]));
        return "0x";
      case "installModule":
        this.installModule(ctx, record, a[0] as bigint, getAddress(a[1] as Address), a[2] as Hex);
        return "0x";
      case "uninstallModule":
        this.uninstallModule(ctx, record, a[0] as bigint, getAddress(a[1] as Address), a[2] as Hex);
        return "0x";
      default:
        return revert(`simulator: account function ${decoded.functionName} is not supported as a self-call`);
    }
  }

  private installModule(
    ctx: ExecContext,
    record: SimAccountRecord,
    type: bigint,
    module: Address,
    data: Hex,
  ): void {
    if (type === MODULE_TYPE.hook) {
      const [hookType, selector, initData] = decodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
        data,
      );
      if (hookType !== 0 || selector !== "0x00000000") revert("simulator: only global hooks are simulated");
      if (record.globalHook !== zeroAddress) revert(`HookAlreadyInstalled(${record.globalHook})`);
      this.checkRegistry(record, module);
      if (module !== this.hook.address) revert(`simulator: hook ${module} is not simulated`);
      this.save({ ...this.get(record.address)!, globalHook: module });
      this.hook.onInstall(ctx, record.address, initData);
      return;
    }
    if (type === MODULE_TYPE.executor) {
      this.checkRegistry(record, module);
      if (record.executors.includes(module)) revert("LinkedList_EntryAlreadyInList");
      const handler = this.executorModules[module.toLowerCase()];
      if (!handler) revert(`simulator: executor ${module} is not simulated`);
      this.save({ ...this.get(record.address)!, executors: [...record.executors, module] });
      handler.onInstall(ctx, record.address, data);
      return;
    }
    if (type === MODULE_TYPE.validator) {
      this.checkRegistry(record, module);
      if (record.validators.includes(module)) revert("LinkedList_EntryAlreadyInList");
      revert(`simulator: validator ${module} is not simulated`);
    }
    revert(`UnsupportedModuleType(${type})`);
  }

  private uninstallModule(
    ctx: ExecContext,
    record: SimAccountRecord,
    type: bigint,
    module: Address,
    data: Hex,
  ): void {
    if (type === MODULE_TYPE.hook) {
      const [hookType, selector] = decodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
        data,
      );
      if (hookType !== 0 || selector !== "0x00000000") revert("simulator: only global hooks are simulated");
      this.save({ ...record, globalHook: zeroAddress });
      if (module === this.hook.address) this.hook.onUninstall(ctx, record.address);
      return;
    }
    if (type === MODULE_TYPE.executor) {
      if (!record.executors.includes(module)) revert("LinkedList_InvalidEntry");
      this.save({ ...record, executors: record.executors.filter((e) => e !== module) });
      this.executorModules[module.toLowerCase()]?.onUninstall(ctx, record.address);
      return;
    }
    revert(`simulator: uninstalling module type ${type} is not simulated`);
  }

  /**
   * `execute(mode, executionCalldata)` with the global hook's `preCheck`. Default exec type reverts
   * the whole batch on the first failure; try mode skips failed calls.
   */
  execute(ctx: ExecContext, account: Address, callData: Hex): void {
    const record = this.get(account);
    if (!record || record.stage !== "ready") revert("account not ready");
    if (record.globalHook !== zeroAddress) this.hook.preCheck(ctx, account, callData);
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: safe7579Abi, data: callData });
    } catch {
      revert("simulator: unsupported account call");
    }
    if (decoded.functionName !== "execute" && decoded.functionName !== "executeFromExecutor") {
      revert(`simulator: account function ${decoded.functionName} is not supported here`);
    }
    const [mode, executionCalldata] = decoded.args as readonly [Hex, Hex];
    this.runExecutions(ctx, account, mode, executionCalldata);
  }

  /** `executeFromExecutor(mode, data)` called by an installed executor module. */
  executeFromExecutor(ctx: ExecContext, executor: Address, account: Address, callData: Hex): void {
    const record = this.get(account);
    if (!record || record.stage !== "ready") revert("account not ready");
    if (!record.executors.includes(getAddress(executor))) revert(`InvalidModule(${executor})`);
    this.checkRegistry(record, getAddress(executor));
    this.execute(ctx, account, callData);
  }

  private runExecutions(ctx: ExecContext, account: Address, mode: Hex, executionCalldata: Hex): void {
    const m = decodeExecutionMode(mode);
    let calls: { target: Address; value: bigint; callData: Hex }[];
    if (m.callType === CALLTYPE_SINGLE) {
      check(size(executionCalldata) >= 52, "invalid single execution");
      calls = [
        {
          target: getAddress(slice(executionCalldata, 0, 20)),
          value: BigInt(slice(executionCalldata, 20, 52)),
          callData: size(executionCalldata) > 52 ? slice(executionCalldata, 52) : "0x",
        },
      ];
    } else if (m.callType === CALLTYPE_BATCH) {
      const [executions] = decodeAbiParameters(
        [
          {
            type: "tuple[]",
            components: [
              { type: "address", name: "target" },
              { type: "uint256", name: "value" },
              { type: "bytes", name: "callData" },
            ],
          },
        ],
        executionCalldata,
      );
      calls = executions.map((e) => ({ target: getAddress(e.target), value: e.value, callData: e.callData }));
    } else {
      return revert(`UnsupportedCallType(${m.callType})`);
    }
    if (m.execType !== EXECTYPE_DEFAULT && m.execType !== EXECTYPE_TRY)
      revert(`UnsupportedExecType(${m.execType})`);
    for (const c of calls) {
      if (m.execType === EXECTYPE_TRY) {
        const mark = ctx.journal.mark();
        try {
          this.world.call(ctx, account, c.target, c.value, c.callData);
        } catch (error) {
          if (!(error instanceof SimRevert)) throw error;
          ctx.journal.revertTo(mark);
        }
      } else {
        this.world.call(ctx, account, c.target, c.value, c.callData);
      }
    }
  }
}
