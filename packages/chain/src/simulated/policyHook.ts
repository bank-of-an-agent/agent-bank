import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  size,
  slice,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { agentPolicyHookAbi, CONTRACT_KIND, policyConfigParams, type ContractKindName } from "../abis";
import {
  CALLTYPE_BATCH,
  CALLTYPE_SINGLE,
  decodeExecutionMode,
  EXECTYPE_DEFAULT,
  EXECTYPE_TRY,
} from "../erc7579";
import { JMap } from "./journal";
import { DAY, emitLog, eventOf, key, revert, type ExecContext } from "./vm";
import type { World } from "./world";

const SPEND_RECORDED = eventOf(agentPolicyHookAbi, "SpendRecorded");
const POLICY_INSTALLED = eventOf(agentPolicyHookAbi, "PolicyInstalled");
const POLICY_UNINSTALLED = eventOf(agentPolicyHookAbi, "PolicyUninstalled");

const ERC20_TRANSFER = "0xa9059cbb";
const ERC20_TRANSFER_FROM = "0x23b872dd";
const ERC20_APPROVE = "0x095ea7b3";
const ERC20_INCREASE_ALLOWANCE = "0x39509351";
const ERC20_DECREASE_ALLOWANCE = "0xa457c2d7";
const EXECUTE = toFunctionSelector("execute(bytes32,bytes)");
const EXECUTE_FROM_EXECUTOR = toFunctionSelector("executeFromExecutor(bytes32,bytes)");
const ESCROW_LOCK = toFunctionSelector(
  "lock(address,address,uint256,uint64,address,address,bytes32,uint8,bytes32)",
);
const STREAM_CREATE = toFunctionSelector(
  "createStream(address,address,uint256,uint256,uint64,uint64,uint64)",
);
const VAULT_DEPOSIT = toFunctionSelector("deposit(uint256,uint256)");

const KIND_NAMES = Object.fromEntries(Object.entries(CONTRACT_KIND).map(([k, v]) => [v, k])) as Record<
  number,
  ContractKindName
>;

/** Per-account hook state (mirrors the contract's storage for the current epoch). */
export interface HookAccountState {
  initialized: boolean;
  epoch: number;
  recipientAllowlistEnabled: boolean;
}

interface Execution {
  target: Address;
  value: bigint;
  callData: Hex;
}

/**
 * `AgentPolicyHook` semantics (contracts/src/AgentPolicyHook.sol): per-token per-operation and
 * UTC-day caps, fail-closed target classification, approvals only to allowlisted contracts,
 * optional recipient allowlist covering escrow/stream payees and vault parents.
 */
export class SimPolicyHook {
  private readonly accounts: JMap<string, HookAccountState>;
  private readonly limits: JMap<string, { maxPerTx: bigint; maxPerDay: bigint }>;
  private readonly windows: JMap<string, { day: bigint; spent: bigint }>;
  private readonly recipients: JMap<string, true>;
  private readonly contracts: JMap<string, ContractKindName>;

  constructor(
    world: World,
    readonly address: Address,
    /** Resolves a vault id to its parent account (for `TimeLockVaults` deposits). */
    private readonly vaultAccount: (vaults: Address, id: bigint) => Address,
  ) {
    const j = world.journal;
    this.accounts = new JMap(j);
    this.limits = new JMap(j);
    this.windows = new JMap(j);
    this.recipients = new JMap(j);
    this.contracts = new JMap(j);
  }

  state(account: Address): HookAccountState {
    return (
      this.accounts.get(key(account)) ?? { initialized: false, epoch: 0, recipientAllowlistEnabled: false }
    );
  }

  tokenLimit(account: Address, token: Address): { maxPerTx: bigint; maxPerDay: bigint } {
    return this.limits.get(key(account, this.state(account).epoch, token)) ?? { maxPerTx: 0n, maxPerDay: 0n };
  }

  spentToday(account: Address, token: Address, timestamp: number): bigint {
    const w = this.windows.get(key(account, this.state(account).epoch, token));
    return w && w.day === BigInt(Math.floor(timestamp / DAY)) ? w.spent : 0n;
  }

  isRecipientAllowed(account: Address, recipient: Address): boolean {
    return this.recipients.has(key(account, this.state(account).epoch, recipient));
  }

  contractKind(account: Address, target: Address): ContractKindName {
    return this.contracts.get(key(account, this.state(account).epoch, target)) ?? "None";
  }

  /** `onInstall(data)` with `msg.sender = account`. */
  onInstall(ctx: ExecContext, account: Address, data: Hex): void {
    const st = this.state(account);
    if (st.initialized) revert(`AlreadyInitialized(${account})`);
    this.accounts.set(key(account), { ...st, initialized: true });
    emitLog(ctx, this.address, POLICY_INSTALLED, { account, epoch: BigInt(st.epoch) });
    if (size(data) !== 0) {
      const [config] = decodeAbiParameters(policyConfigParams, data);
      this.applyConfig(account, st.epoch, config);
    }
  }

  /** `onUninstall` with `msg.sender = account`: never reverts. */
  onUninstall(ctx: ExecContext, account: Address): void {
    const st = this.state(account);
    if (!st.initialized) return;
    this.accounts.set(key(account), {
      initialized: false,
      recipientAllowlistEnabled: false,
      epoch: st.epoch + 1,
    });
    emitLog(ctx, this.address, POLICY_UNINSTALLED, { account, epoch: BigInt(st.epoch) });
  }

  private applyConfig(
    account: Address,
    epoch: number,
    config: {
      tokenLimits: readonly { token: Address; maxPerTx: bigint; maxPerDay: bigint }[];
      allowedRecipients: readonly Address[];
      allowedContracts: readonly { target: Address; kind: number }[];
      recipientAllowlistEnabled: boolean;
    },
  ): void {
    for (const l of config.tokenLimits) {
      if (getAddress(l.token) === getAddress(account) || getAddress(l.token) === this.address) {
        revert(`InvalidAddress(${l.token})`);
      }
      const removing = l.maxPerTx === 0n && l.maxPerDay === 0n;
      if (!removing && (l.maxPerTx === 0n || l.maxPerTx > l.maxPerDay)) {
        revert(`InvalidTokenLimit(${l.token}, ${l.maxPerTx}, ${l.maxPerDay})`);
      }
      this.limits.set(key(account, epoch, l.token), { maxPerTx: l.maxPerTx, maxPerDay: l.maxPerDay });
    }
    for (const r of config.allowedRecipients) {
      if (r === zeroAddress) revert(`InvalidAddress(${r})`);
      this.recipients.set(key(account, epoch, r), true);
    }
    for (const c of config.allowedContracts) {
      if (
        c.target === zeroAddress ||
        getAddress(c.target) === getAddress(account) ||
        getAddress(c.target) === this.address
      ) {
        revert(`InvalidAddress(${c.target})`);
      }
      const name = KIND_NAMES[c.kind];
      if (!name) revert("invalid ContractKind");
      if (name === "None") this.contracts.delete(key(account, epoch, c.target));
      else this.contracts.set(key(account, epoch, c.target), name);
    }
    const st = this.state(account);
    this.accounts.set(key(account), { ...st, recipientAllowlistEnabled: config.recipientAllowlistEnabled });
  }

  /** Direct configuration calls (`msg.sender == account`, only through the owner's native Safe path). */
  handle(_ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: agentPolicyHookAbi, data });
    } catch {
      revert("AgentPolicyHook: unsupported function");
    }
    const st = this.state(from);
    if (!st.initialized) revert(`NotInitialized(${from})`);
    const a = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "applyConfig":
        this.applyConfig(from, st.epoch, a[0] as Parameters<SimPolicyHook["applyConfig"]>[2]);
        return "0x";
      case "setTokenLimit":
        this.applyConfig(from, st.epoch, {
          tokenLimits: [{ token: a[0] as Address, maxPerTx: a[1] as bigint, maxPerDay: a[2] as bigint }],
          allowedRecipients: [],
          allowedContracts: [],
          recipientAllowlistEnabled: st.recipientAllowlistEnabled,
        });
        return "0x";
      default:
        return revert(`AgentPolicyHook: ${decoded.functionName} is not simulated`);
    }
  }

  /** `preCheck(msgSender, msgValue, msgData)` with `msg.sender = account`. */
  preCheck(ctx: ExecContext, account: Address, msgData: Hex): void {
    if (size(msgData) < 4) return;
    const selector = slice(msgData, 0, 4);
    if (selector !== EXECUTE && selector !== EXECUTE_FROM_EXECUTOR) return;
    const st = this.state(account);
    if (!st.initialized) revert(`NotInitialized(${account})`);
    const [mode, executionCalldata] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }],
      slice(msgData, 4),
    );
    this.enforce(ctx, account, st, this.decodeExecutions(mode, executionCalldata));
  }

  private decodeExecutions(mode: Hex, executionCalldata: Hex): Execution[] {
    const m = decodeExecutionMode(mode);
    if (m.execType !== EXECTYPE_DEFAULT && m.execType !== EXECTYPE_TRY)
      revert(`UnsupportedExecType(${m.execType})`);
    if (m.modeSelector !== "0x00000000") revert(`UnsupportedModeSelector(${m.modeSelector})`);
    if (m.callType === CALLTYPE_BATCH) {
      const [executions] = decodeAbiParameters(
        [
          {
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "callData", type: "bytes" },
            ],
          },
        ],
        executionCalldata,
      );
      return executions.map((e) => ({ target: getAddress(e.target), value: e.value, callData: e.callData }));
    }
    if (m.callType === CALLTYPE_SINGLE) {
      if (size(executionCalldata) < 52) revert("MalformedExecution()");
      return [
        {
          target: getAddress(slice(executionCalldata, 0, 20)),
          value: BigInt(slice(executionCalldata, 20, 52)),
          callData: size(executionCalldata) > 52 ? slice(executionCalldata, 52) : "0x",
        },
      ];
    }
    return revert(`UnsupportedCallType(${m.callType})`);
  }

  private enforce(ctx: ExecContext, account: Address, st: HookAccountState, executions: Execution[]): void {
    const totals = new Map<string, { token: Address; amount: bigint }>();
    const add = (token: Address, amount: bigint) => {
      const k = token.toLowerCase();
      const prev = totals.get(k);
      totals.set(k, { token, amount: (prev?.amount ?? 0n) + amount });
    };
    for (const e of executions) {
      const { token, amount, nativeAmount } = this.classify(account, st, e);
      if (nativeAmount !== 0n) add(zeroAddress, nativeAmount);
      if (amount !== 0n) add(token, amount);
    }
    for (const { token, amount } of totals.values()) this.consume(ctx, account, st.epoch, token, amount);
  }

  private classify(
    account: Address,
    st: HookAccountState,
    e: Execution,
  ): { token: Address; amount: bigint; nativeAmount: bigint } {
    const none = { token: zeroAddress as Address, amount: 0n, nativeAmount: 0n };
    if (e.target === getAddress(account)) return none;
    if (e.target === this.address) revert("HookCallBlocked()");
    let nativeAmount = 0n;
    if (e.value !== 0n) {
      this.requireRecipient(account, st, e.target);
      nativeAmount = e.value;
    }
    if (e.target !== zeroAddress && this.tokenLimit(account, e.target).maxPerDay !== 0n) {
      const { token, amount } = this.classifyTokenCall(account, st, e.target, e.callData);
      return { token, amount, nativeAmount };
    }
    const kind = this.contractKind(account, e.target);
    if (kind !== "None") {
      this.checkContractCall(account, st, e.target, kind, e.callData);
      return { ...none, nativeAmount };
    }
    if (size(e.callData) === 0) return { ...none, nativeAmount };
    return revert(`TargetNotAllowed(${e.target})`);
  }

  private classifyTokenCall(
    account: Address,
    st: HookAccountState,
    token: Address,
    data: Hex,
  ): { token: Address; amount: bigint } {
    if (size(data) < 4) revert(`UnsupportedTokenCall(${token}, 0x00000000)`);
    const selector = slice(data, 0, 4);
    if (selector === ERC20_TRANSFER) {
      const to = addressArg(data, 0);
      const amount = uintArg(data, 1);
      if (to === getAddress(account)) return { token, amount: 0n };
      this.requireRecipient(account, st, to);
      return { token, amount };
    }
    if (selector === ERC20_TRANSFER_FROM) {
      addressArg(data, 0);
      const to = addressArg(data, 1);
      const amount = uintArg(data, 2);
      if (to === getAddress(account)) return { token, amount: 0n };
      this.requireRecipient(account, st, to);
      return { token, amount };
    }
    if (selector === ERC20_APPROVE || selector === ERC20_INCREASE_ALLOWANCE) {
      const spender = addressArg(data, 0);
      const amount = uintArg(data, 1);
      if (amount === 0n) return { token, amount: 0n };
      if (this.contractKind(account, spender) === "None") revert(`SpenderNotAllowed(${spender})`);
      return { token, amount };
    }
    if (selector === ERC20_DECREASE_ALLOWANCE) {
      addressArg(data, 0);
      uintArg(data, 1);
      return { token, amount: 0n };
    }
    return revert(`UnsupportedTokenCall(${token}, ${selector})`);
  }

  private checkContractCall(
    account: Address,
    st: HookAccountState,
    target: Address,
    kind: ContractKindName,
    data: Hex,
  ): void {
    if (!st.recipientAllowlistEnabled || kind === "Generic" || size(data) < 4) return;
    const selector = slice(data, 0, 4);
    if (kind === "AgentEscrow" && selector === ESCROW_LOCK)
      this.requireRecipient(account, st, addressArg(data, 1));
    else if (kind === "PaymentStreams" && selector === STREAM_CREATE)
      this.requireRecipient(account, st, addressArg(data, 1));
    else if (kind === "TimeLockVaults" && selector === VAULT_DEPOSIT) {
      this.requireRecipient(account, st, this.vaultAccount(target, uintArg(data, 0)));
    }
  }

  private requireRecipient(account: Address, st: HookAccountState, recipient: Address): void {
    if (!st.recipientAllowlistEnabled || getAddress(recipient) === getAddress(account)) return;
    if (this.isRecipientAllowed(account, recipient)) return;
    if (this.contractKind(account, recipient) !== "None") return;
    revert(`RecipientNotAllowed(${recipient})`);
  }

  private consume(ctx: ExecContext, account: Address, epoch: number, token: Address, amount: bigint): void {
    const limit = this.limits.get(key(account, epoch, token)) ?? { maxPerTx: 0n, maxPerDay: 0n };
    if (limit.maxPerDay === 0n) revert(`TokenNotConfigured(${token})`);
    if (amount > limit.maxPerTx) revert(`PerTxLimitExceeded(${token}, ${amount}, ${limit.maxPerTx})`);
    const today = BigInt(Math.floor(ctx.timestamp / DAY));
    const w = this.windows.get(key(account, epoch, token));
    const newSpent = (w && w.day === today ? w.spent : 0n) + amount;
    if (newSpent > limit.maxPerDay) revert(`DailyLimitExceeded(${token}, ${newSpent}, ${limit.maxPerDay})`);
    this.windows.set(key(account, epoch, token), { day: today, spent: newSpent });
    emitLog(ctx, this.address, SPEND_RECORDED, { account, token, amount, spentToday: newSpent });
  }
}

function uintArg(data: Hex, index: number): bigint {
  const start = 4 + 32 * index;
  if (size(data) < start + 32) revert("MalformedExecution()");
  return BigInt(slice(data, start, start + 32));
}

function addressArg(data: Hex, index: number): Address {
  const word = uintArg(data, index);
  if (word >> 160n !== 0n) revert("MalformedExecution()");
  return getAddress(`0x${word.toString(16).padStart(40, "0")}`);
}
