import { AgentBankError, assertTestnet, chainById, CHAINS, type ChainInfo } from "@agentbank/core";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  pad,
  size,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
} from "viem";
import {
  UserOperationNotFoundError,
  UserOperationReceiptNotFoundError,
  type UserOperation,
} from "viem/account-abstraction";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { accountFactoryArgs, predictAccountAddress, wrapSetupSafe } from "../account";
import { entryPointAbi, erc20Abi, smartSessionsAbi } from "../abis";
import {
  anvilForkContracts,
  baseSepoliaContracts,
  DEFAULT_OWNER_OP_TTL_SECONDS,
  DEFAULT_SESSION_OP_TTL_SECONDS,
} from "../constants";
import { decodeCalls } from "../decode";
import { encodeExecute, validatorNonceKey } from "../erc7579";
import { userOperationToJson, type UserOperationV07 } from "../json";
import {
  EVENT_TOPICS,
  eventSourceAddress,
  logInvolves,
  normalizeLog,
  partyTopicPositions,
  sortLogs,
  type RawLog,
} from "../logs";
import { stubOwnerSignature, stubSessionSignature } from "../signing";
import {
  CHAIN_EVENT_NAMES,
  type AccountDeployment,
  type BlockRef,
  type BlockTag,
  type ChainContracts,
  type ChainEventName,
  type ChainGateway,
  type ChainLog,
  type DecodedCall,
  type LogQuery,
  type OperationReceipt,
  type PreparedOperation,
  type PrepareOperationInput,
  type PrepareOwnerOperationInput,
  type RelayCallInput,
  type SettleAuthorizationInput,
  type SubmitOperationInput,
} from "../types";
import { checkPreparedOperation, decodePreparedOperation, hashUserOperation, nowSeconds } from "../userop";

/** Configuration of an {@link EvmChainGateway}. */
export interface EvmChainGatewayConfig {
  /** 84532 (Base Sepolia) or 31337 (Anvil). Mainnet ids are refused. */
  chainId: number;
  /** JSON-RPC node URL (reads, log queries, relayed transactions). */
  rpcUrl: string;
  /**
   * ERC-4337 bundler URL: Pimlico (`pimlicoUrl(chainId, apiKey)`) or a local Alto. Required for
   * preparing, submitting and tracking user operations.
   */
  bundlerUrl?: string;
  /** ERC-7677 paymaster URL (default: `bundlerUrl` when sponsoring). */
  paymasterUrl?: string;
  /** Sponsor gas with the paymaster (default: true when a bundler is configured and the chain is not Anvil). */
  sponsor?: boolean;
  /** Paymaster context, e.g. `{ sponsorshipPolicyId }` for Pimlico. */
  paymasterContext?: Record<string, unknown>;
  /** Contract addresses (default: {@link baseSepoliaContracts} / {@link anvilForkContracts}). */
  contracts?: ChainContracts;
  /** Default relayer for `settleAuthorization` and `relayCall` (testnet key from the secret manager). */
  relayer?: LocalAccount;
  /** Node transport (default `http(rpcUrl)`); lets tests and callers inject their own. */
  transport?: Transport;
  /** Bundler transport (default `http(bundlerUrl)`). */
  bundlerTransport?: Transport;
  /** Paymaster transport (default `http(paymasterUrl ?? bundlerUrl)`). */
  paymasterTransport?: Transport;
  /**
   * Largest block range per `eth_getLogs` request (default 200, the public Base Sepolia RPC's limit).
   * Ranges are split further automatically when a provider reports a lower limit.
   */
  maxLogBlockRange?: bigint;
  /** Percent added to the bundler's verification gas estimate (default 20). */
  verificationGasBufferPercent?: number;
  /** Percent added to the bundler's call gas estimate (default 10). */
  callGasBufferPercent?: number;
}

/** Pimlico bundler/paymaster endpoint. The key comes from the environment (`PIMLICO_API_KEY`), never the repo. */
export function pimlicoUrl(chainId: number, apiKey: string): string {
  assertTestnet(chainId);
  if (!apiKey) throw new AgentBankError("invalid_request", "PIMLICO_API_KEY is empty");
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;
}

/**
 * Build an {@link EvmChainGateway} from environment variables: `AGENTBANK_CHAIN` (`base-sepolia` |
 * `anvil`), `BASE_SEPOLIA_RPC_URL` / `ANVIL_RPC_URL`, `BUNDLER_URL` or `PIMLICO_API_KEY`,
 * `PIMLICO_SPONSORSHIP_POLICY_ID`. Contract addresses and the relayer are passed in.
 */
export function evmGatewayFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<EvmChainGatewayConfig> = {},
): EvmChainGateway {
  const name = env.AGENTBANK_CHAIN ?? "base-sepolia";
  if (name !== "base-sepolia" && name !== "anvil") {
    throw new AgentBankError("unsupported_chain", `AGENTBANK_CHAIN=${name} is not an EVM testnet`);
  }
  const chain = CHAINS[name];
  const rpcUrl =
    name === "anvil"
      ? (env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545")
      : (env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org");
  const bundlerUrl =
    env.BUNDLER_URL ?? (env.PIMLICO_API_KEY ? pimlicoUrl(chain.id, env.PIMLICO_API_KEY) : undefined);
  const policy = env.PIMLICO_SPONSORSHIP_POLICY_ID;
  return new EvmChainGateway({
    chainId: chain.id,
    rpcUrl,
    ...(bundlerUrl ? { bundlerUrl } : {}),
    ...(policy ? { paymasterContext: { sponsorshipPolicyId: policy } } : {}),
    ...overrides,
  });
}

function viemChain(info: ChainInfo, rpcUrl: string): Chain {
  return defineChain({
    id: info.id,
    name: info.displayName,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
}

/** Map a bundler error to an Agent Bank error (validation codes per ERC-4337). */
export function bundlerError(error: unknown): AgentBankError {
  const message =
    error instanceof BaseError
      ? `${error.shortMessage} ${error.details ?? ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  const reason = message.trim().slice(0, 500);
  const match = /\bAA(\d\d)\b/.exec(message);
  const code = match?.[1];
  if (code === "24" || /signature/i.test(message))
    return new AgentBankError("signature_invalid", `Operation rejected: ${reason}`, { reason });
  if (code === "22")
    return new AgentBankError("session_expired", `Operation rejected: ${reason}`, { reason });
  if (code === "23") return new AgentBankError("policy_denied", `Operation rejected: ${reason}`, { reason });
  if (code === "25") return new AgentBankError("invalid_state", `Operation rejected: ${reason}`, { reason });
  if (code !== undefined && code.startsWith("1"))
    return new AgentBankError("invalid_request", `Operation rejected: ${reason}`, { reason });
  if (/reverted during simulation|execution reverted/i.test(message)) {
    // The account's execution would revert (e.g. AgentPolicyHook caps, escrow rules). Safe7579
    // reports inner failures as ExecutionFailed() (0xacfdb444) without the inner reason.
    const revertData = /reason: (0x[0-9a-fA-F]*)/.exec(message)?.[1] ?? null;
    return new AgentBankError("invalid_state", `Operation would revert: ${reason}`, { reason, revertData });
  }
  return new AgentBankError("chain_error", `Bundler error: ${reason}`, { reason });
}

function revertError(error: unknown): AgentBankError {
  const reason =
    error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  return new AgentBankError("invalid_state", `Transaction would revert: ${reason}`, { revertReason: reason });
}

function withBuffer(value: bigint, percent: number): bigint {
  return value + (value * BigInt(Math.round(percent))) / 100n;
}

function addressTopic(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 });
}

/**
 * {@link ChainGateway} for Base Sepolia (84532) and Anvil (31337): Safe7579 accounts, ERC-4337 v0.7
 * user operations through a bundler (Pimlico or Alto) with optional paymaster sponsorship, Smart
 * Sessions USE-mode signatures, log queries and EIP-3009 settlement. Every entry point asserts a
 * testnet chain id, and the node's chain id is checked against the configuration.
 */
export class EvmChainGateway implements ChainGateway {
  readonly chainId: number;
  readonly contracts: ChainContracts;
  readonly publicClient: PublicClient<Transport, Chain>;
  private readonly chain: Chain;
  private readonly config: EvmChainGatewayConfig;
  private chainCheck: Promise<void> | undefined;

  constructor(config: EvmChainGatewayConfig) {
    const info = chainById(config.chainId);
    if (info.name === "simulated")
      throw new AgentBankError("unsupported_chain", "Use SimulatedChain for the simulated chain");
    this.chainId = info.id;
    this.config = config;
    this.contracts =
      config.contracts ?? (info.name === "anvil" ? anvilForkContracts() : baseSepoliaContracts());
    this.chain = viemChain(info, config.rpcUrl);
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: config.transport ?? http(config.rpcUrl),
    });
  }

  /** Assert a testnet id and that the node really serves it (once per gateway). */
  private async ready(): Promise<void> {
    assertTestnet(this.chainId);
    this.chainCheck ??= this.publicClient.getChainId().then((id) => {
      assertTestnet(id);
      if (id !== this.chainId) {
        throw new AgentBankError(
          "unsupported_chain",
          `RPC serves chain ${id}, gateway is configured for ${this.chainId}`,
        );
      }
    });
    try {
      await this.chainCheck;
    } catch (error) {
      this.chainCheck = undefined;
      throw error;
    }
  }

  private bundler() {
    const transport =
      this.config.bundlerTransport ?? (this.config.bundlerUrl ? http(this.config.bundlerUrl) : undefined);
    if (!transport) {
      throw new AgentBankError("chain_error", "No bundler configured (BUNDLER_URL or PIMLICO_API_KEY)");
    }
    return createPimlicoClient({
      chain: this.chain,
      transport,
      entryPoint: { address: this.contracts.entryPoint, version: "0.7" },
    });
  }

  private paymaster() {
    let transport = this.config.paymasterTransport;
    if (!transport && this.config.paymasterUrl) transport = http(this.config.paymasterUrl);
    transport ??=
      this.config.bundlerTransport ?? (this.config.bundlerUrl ? http(this.config.bundlerUrl) : undefined);
    if (!transport) throw new AgentBankError("chain_error", "No paymaster configured");
    return createPimlicoClient({
      chain: this.chain,
      transport,
      entryPoint: { address: this.contracts.entryPoint, version: "0.7" },
    });
  }

  private get sponsored(): boolean {
    const configured = Boolean(
      this.config.bundlerUrl ??
      this.config.paymasterUrl ??
      this.config.bundlerTransport ??
      this.config.paymasterTransport,
    );
    return this.config.sponsor ?? (configured && this.chainId !== CHAINS.anvil.id);
  }

  async predictAccountAddress(input: AccountDeployment): Promise<Address> {
    assertTestnet(this.chainId);
    return predictAccountAddress(input, this.contracts);
  }

  async isDeployed(address: Address): Promise<boolean> {
    await this.ready();
    const code = await this.publicClient.getCode({ address });
    return code !== undefined && size(code) > 0;
  }

  async getTokenBalance(token: Address, holder: Address, blockNumber?: bigint): Promise<bigint> {
    await this.ready();
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
  }

  async isSessionEnabled(account: Address, permissionId: Hex): Promise<boolean> {
    await this.ready();
    return this.publicClient.readContract({
      address: this.contracts.smartSessions,
      abi: smartSessionsAbi,
      functionName: "isPermissionEnabled",
      args: [permissionId, account],
    });
  }

  private async nonce(account: Address, validator: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.contracts.entryPoint,
      abi: entryPointAbi,
      functionName: "getNonce",
      args: [account, validatorNonceKey(validator)],
    });
  }

  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    try {
      return (await this.bundler().getUserOperationGasPrice()).fast;
    } catch {
      const fees = await this.publicClient.estimateFeesPerGas({ type: "eip1559" });
      return { maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 2n };
    }
  }

  /** Fill fees, paymaster and gas for a user operation whose `signature` is a stub; returns it unsigned. */
  private async fill(
    op: Omit<
      UserOperationV07,
      "callGasLimit" | "verificationGasLimit" | "preVerificationGas" | "maxFeePerGas" | "maxPriorityFeePerGas"
    >,
  ): Promise<UserOperationV07> {
    const bundler = this.bundler();
    let userOp: UserOperationV07 = {
      ...op,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      ...(await this.fees()),
    };
    const context = this.config.paymasterContext;
    if (this.sponsored) {
      const stub = await this.paymaster().getPaymasterStubData({
        ...(userOp as UserOperation<"0.7">),
        chainId: this.chainId,
        entryPointAddress: this.contracts.entryPoint,
        ...(context ? { context } : {}),
      });
      userOp = {
        ...userOp,
        paymaster: stub.paymaster as Address,
        paymasterData: stub.paymasterData as Hex,
        paymasterVerificationGasLimit:
          (stub as { paymasterVerificationGasLimit?: bigint }).paymasterVerificationGasLimit ?? 0n,
        paymasterPostOpGasLimit: (stub as { paymasterPostOpGasLimit?: bigint }).paymasterPostOpGasLimit ?? 0n,
      };
    }
    let gas;
    try {
      gas = await bundler.estimateUserOperationGas({
        ...(userOp as UserOperation<"0.7">),
        entryPointAddress: this.contracts.entryPoint,
      });
    } catch (error) {
      throw bundlerError(error);
    }
    userOp = {
      ...userOp,
      callGasLimit: withBuffer(gas.callGasLimit, this.config.callGasBufferPercent ?? 10),
      verificationGasLimit: withBuffer(
        gas.verificationGasLimit,
        this.config.verificationGasBufferPercent ?? 20,
      ),
      preVerificationGas: gas.preVerificationGas,
      ...(this.sponsored && gas.paymasterVerificationGasLimit !== undefined
        ? { paymasterVerificationGasLimit: gas.paymasterVerificationGasLimit }
        : {}),
      ...(this.sponsored && gas.paymasterPostOpGasLimit !== undefined
        ? { paymasterPostOpGasLimit: gas.paymasterPostOpGasLimit }
        : {}),
    };
    if (this.sponsored) {
      const final = await this.paymaster().getPaymasterData({
        ...(userOp as UserOperation<"0.7">),
        chainId: this.chainId,
        entryPointAddress: this.contracts.entryPoint,
        ...(context ? { context } : {}),
      });
      userOp = {
        ...userOp,
        paymaster: final.paymaster as Address,
        paymasterData: final.paymasterData as Hex,
        ...((final as { paymasterVerificationGasLimit?: bigint }).paymasterVerificationGasLimit !== undefined
          ? {
              paymasterVerificationGasLimit: (final as { paymasterVerificationGasLimit: bigint })
                .paymasterVerificationGasLimit,
            }
          : {}),
        ...((final as { paymasterPostOpGasLimit?: bigint }).paymasterPostOpGasLimit !== undefined
          ? {
              paymasterPostOpGasLimit: (final as { paymasterPostOpGasLimit: bigint }).paymasterPostOpGasLimit,
            }
          : {}),
      };
    }
    return { ...userOp, signature: "0x" };
  }

  private finish(
    userOp: UserOperationV07,
    signer: "session" | "owner",
    permissionId: Hex | null,
    validUntil: number,
  ): PreparedOperation {
    const json = userOperationToJson(userOp);
    return {
      chainId: this.chainId,
      entryPoint: getAddress(this.contracts.entryPoint),
      account: getAddress(userOp.sender),
      signer,
      permissionId,
      userOp: json,
      userOpHash: hashUserOperation(json, this.chainId, this.contracts.entryPoint),
      calls: decodeCalls(userOp.callData, { contracts: this.contracts, account: userOp.sender }),
      validUntil,
    };
  }

  async prepareOperation(input: PrepareOperationInput): Promise<PreparedOperation> {
    await this.ready();
    const account = getAddress(input.account);
    if (input.calls.length === 0)
      throw new AgentBankError("invalid_request", "at least one call is required");
    if (!(await this.isDeployed(account)))
      throw new AgentBankError("invalid_state", `Account ${account} is not deployed`);
    if (!(await this.isSessionEnabled(account, input.session.permissionId))) {
      throw new AgentBankError(
        "session_revoked",
        `Session ${input.session.permissionId} is not enabled on ${account}`,
      );
    }
    const userOp = await this.fill({
      sender: account,
      nonce: await this.nonce(account, this.contracts.smartSessions),
      callData: encodeExecute(input.calls),
      signature: stubSessionSignature(input.session.permissionId),
    });
    return this.finish(
      userOp,
      "session",
      input.session.permissionId,
      input.validUntil ?? nowSeconds() + DEFAULT_SESSION_OP_TTL_SECONDS,
    );
  }

  async prepareOwnerOperation(input: PrepareOwnerOperationInput): Promise<PreparedOperation> {
    await this.ready();
    const account = getAddress(input.account);
    if (input.calls.length === 0)
      throw new AgentBankError("invalid_request", "at least one call is required");
    const execute = encodeExecute(input.calls);
    const deployed = await this.isDeployed(account);
    let base: Parameters<EvmChainGateway["fill"]>[0];
    if (deployed) {
      base = {
        sender: account,
        nonce: await this.nonce(account, this.contracts.ownableValidator),
        callData: execute,
        signature: stubOwnerSignature(),
      };
    } else {
      if (!input.deployment)
        throw new AgentBankError("invalid_request", "deployment is required for an undeployed account");
      if (!isAddressEqual(predictAccountAddress(input.deployment, this.contracts), account)) {
        throw new AgentBankError("invalid_request", "deployment does not predict to the account address");
      }
      const { factory, factoryData } = accountFactoryArgs(input.deployment, this.contracts);
      base = {
        sender: account,
        nonce: await this.nonce(account, this.contracts.ownableValidator),
        factory,
        factoryData,
        callData: wrapSetupSafe(input.deployment, this.contracts, execute),
        signature: stubOwnerSignature(),
      };
    }
    const userOp = await this.fill(base);
    return this.finish(
      userOp,
      "owner",
      null,
      input.validUntil ?? nowSeconds() + DEFAULT_OWNER_OP_TTL_SECONDS,
    );
  }

  decodeOperation(op: PreparedOperation): DecodedCall[] {
    checkPreparedOperation(op, this);
    return decodePreparedOperation(op, this.contracts);
  }

  hashOperation(op: PreparedOperation): Hex {
    return hashUserOperation(checkPreparedOperation(op, this), this.chainId, this.contracts.entryPoint);
  }

  async submitOperation(input: SubmitOperationInput): Promise<{ userOpHash: Hex }> {
    await this.ready();
    const userOp = checkPreparedOperation(input.op, this);
    if (nowSeconds() > input.op.validUntil) {
      throw new AgentBankError("invalid_state", `Operation signing deadline passed (${input.op.validUntil})`);
    }
    try {
      const userOpHash = await this.bundler().sendUserOperation({
        ...(userOp as UserOperation<"0.7">),
        signature: input.signature,
        entryPointAddress: this.contracts.entryPoint,
      });
      return { userOpHash };
    } catch (error) {
      throw bundlerError(error);
    }
  }

  async getOperationReceipt(userOpHash: Hex): Promise<OperationReceipt> {
    await this.ready();
    const bundler = this.bundler();
    const empty = {
      userOpHash,
      txHash: null,
      blockNumber: null,
      blockHash: null,
      revertReason: null,
      actualGasCost: null,
      logs: [],
    };
    try {
      const r = await bundler.getUserOperationReceipt({ hash: userOpHash });
      const logs = r.logs
        .map((l) =>
          normalizeLog(
            {
              address: l.address,
              topics: l.topics as Hex[],
              data: l.data,
              blockNumber: l.blockNumber,
              blockHash: l.blockHash,
              transactionHash: l.transactionHash,
              logIndex: Number(l.logIndex),
            },
            this.chainId,
            this.contracts,
          ),
        )
        .filter((l): l is ChainLog => l !== null);
      return {
        userOpHash,
        status: r.success ? "succeeded" : "reverted",
        txHash: r.receipt.transactionHash,
        blockNumber: r.receipt.blockNumber,
        blockHash: r.receipt.blockHash,
        revertReason: r.success ? null : (r.reason ?? null),
        actualGasCost: r.actualGasCost,
        logs,
      };
    } catch (error) {
      if (!(error instanceof UserOperationReceiptNotFoundError)) throw bundlerError(error);
    }
    try {
      await bundler.getUserOperation({ hash: userOpHash });
      return { ...empty, status: "pending" };
    } catch (error) {
      if (error instanceof UserOperationNotFoundError) return { ...empty, status: "not_found" };
      throw bundlerError(error);
    }
  }

  async getBlock(tag: BlockTag): Promise<BlockRef> {
    await this.ready();
    const block = await this.publicClient.getBlock(
      typeof tag === "bigint" ? { blockNumber: tag } : { blockTag: tag },
    );
    if (block.number === null || block.hash === null)
      throw new AgentBankError("not_found", "Block is pending");
    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: Number(block.timestamp),
    };
  }

  private async rawLogs(
    filter: { address: Address[]; topics: (Hex | Hex[] | null)[] },
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RawLog[]> {
    const out: RawLog[] = [];
    let step = this.config.maxLogBlockRange ?? 200n;
    let start = fromBlock;
    while (start <= toBlock) {
      const end = start + step - 1n < toBlock ? start + step - 1n : toBlock;
      let logs;
      try {
        logs = await this.publicClient.request({
          method: "eth_getLogs",
          params: [
            {
              address: filter.address,
              topics: filter.topics,
              fromBlock: `0x${start.toString(16)}`,
              toBlock: `0x${end.toString(16)}`,
            },
          ],
        });
      } catch (error) {
        // Providers cap the range (e.g. "eth_getLogs is limited to a 200 range"): split and retry.
        const message =
          error instanceof BaseError ? `${error.shortMessage} ${error.details ?? ""}` : String(error);
        if (step > 1n && /limit|range|too many|too large|exceed/i.test(message)) {
          const advertised = /limited to a (\d+)/.exec(message)?.[1];
          step = advertised && BigInt(advertised) < step ? BigInt(advertised) : step / 2n;
          continue;
        }
        throw new AgentBankError("chain_error", `eth_getLogs failed: ${message.slice(0, 300)}`);
      }
      for (const l of logs) {
        if (
          l.removed ||
          l.blockHash === null ||
          l.blockNumber === null ||
          l.transactionHash === null ||
          l.logIndex === null
        )
          continue;
        out.push({
          address: l.address,
          topics: l.topics as Hex[],
          data: l.data,
          blockNumber: BigInt(l.blockNumber),
          blockHash: l.blockHash,
          transactionHash: l.transactionHash,
          logIndex: Number(BigInt(l.logIndex)),
        });
      }
      start = end + 1n;
    }
    return out;
  }

  async getLogs(input: LogQuery): Promise<ChainLog[]> {
    await this.ready();
    if (input.fromBlock > input.toBlock)
      throw new AgentBankError("invalid_request", "fromBlock must be <= toBlock");
    const wanted = new Set<ChainEventName>(input.events ?? CHAIN_EVENT_NAMES);
    const addressFilter = input.addresses ? new Set(input.addresses.map((a) => a.toLowerCase())) : null;
    const involving = input.involving?.map((a) => getAddress(a));
    const involvingSet = involving ? new Set(involving.map((a) => a.toLowerCase())) : null;

    // Group events by emitting contract.
    const bySource = new Map<string, { address: Address; events: ChainEventName[] }>();
    for (const name of wanted) {
      const address = eventSourceAddress(name, this.contracts);
      if (!address || (addressFilter && !addressFilter.has(address.toLowerCase()))) continue;
      const group = bySource.get(address.toLowerCase()) ?? { address, events: [] };
      group.events.push(name);
      bySource.set(address.toLowerCase(), group);
    }

    const raw: RawLog[] = [];
    for (const { address, events } of bySource.values()) {
      const topics0 = events.map((e) => EVENT_TOPICS[e]);
      if (!involving) {
        raw.push(
          ...(await this.rawLogs({ address: [address], topics: [topics0] }, input.fromBlock, input.toBlock)),
        );
        continue;
      }
      // Server-side topic filters where every party argument is indexed; client-side for the rest.
      const involvingTopics = involving.map(addressTopic);
      const positions = new Map<number, Hex[]>();
      const clientSide: ChainEventName[] = [];
      for (const e of events) {
        const partyPositions = partyTopicPositions(e);
        if (partyPositions === null) {
          clientSide.push(e);
          continue;
        }
        for (const position of partyPositions)
          positions.set(position, [...(positions.get(position) ?? []), EVENT_TOPICS[e]]);
      }
      for (const [position, t0] of positions) {
        const topics: (Hex | Hex[] | null)[] = [t0];
        for (let p = 1; p < position; p++) topics.push(null);
        topics.push(involvingTopics);
        raw.push(...(await this.rawLogs({ address: [address], topics }, input.fromBlock, input.toBlock)));
      }
      if (clientSide.length > 0) {
        raw.push(
          ...(await this.rawLogs(
            { address: [address], topics: [clientSide.map((e) => EVENT_TOPICS[e])] },
            input.fromBlock,
            input.toBlock,
          )),
        );
      }
    }

    const seen = new Set<string>();
    const out: ChainLog[] = [];
    for (const r of raw) {
      const id = `${r.blockHash}:${r.transactionHash}:${r.logIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const log = normalizeLog(r, this.chainId, this.contracts);
      if (!log || !wanted.has(log.eventName)) continue;
      if (involvingSet && !logInvolves(log, involvingSet)) continue;
      out.push(log);
    }
    return sortLogs(out);
  }

  private relayerFor(relayer: LocalAccount | undefined): LocalAccount {
    const account = relayer ?? this.config.relayer;
    if (!account) throw new AgentBankError("invalid_request", "A relayer account is required");
    return account;
  }

  private async relay(relayer: LocalAccount, to: Address, data: Hex): Promise<Hex> {
    try {
      await this.publicClient.call({ account: relayer.address, to, data });
    } catch (error) {
      throw revertError(error);
    }
    const wallet = createWalletClient({
      account: relayer,
      chain: this.chain,
      transport: this.config.transport ?? http(this.config.rpcUrl),
    });
    try {
      return await wallet.sendTransaction({ to, data, account: relayer, chain: this.chain });
    } catch (error) {
      throw new AgentBankError(
        "chain_error",
        `Relay failed: ${error instanceof BaseError ? error.shortMessage : String(error)}`,
      );
    }
  }

  async settleAuthorization(input: SettleAuthorizationInput): Promise<{ txHash: Hex }> {
    await this.ready();
    const relayer = this.relayerFor(input.relayer);
    const args = [
      input.from,
      input.to,
      input.value,
      input.validAfter,
      input.validBefore,
      input.nonce,
    ] as const;
    let data: Hex;
    if (size(input.signature) === 65) {
      const r = `0x${input.signature.slice(2, 66)}` as Hex;
      const s = `0x${input.signature.slice(66, 130)}` as Hex;
      let v = Number.parseInt(input.signature.slice(130, 132), 16);
      if (v < 27) v += 27;
      data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transferWithAuthorization",
        args: [...args, v, r, s],
      });
    } else {
      data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transferWithAuthorization",
        args: [...args, input.signature],
      });
    }
    return { txHash: await this.relay(relayer, input.token, data) };
  }

  async relayCall(input: RelayCallInput): Promise<{ txHash: Hex }> {
    await this.ready();
    const c = this.contracts;
    const allowed = [c.escrow, c.streams, c.vaults, c.topUpExecutor, c.sweepExecutor];
    if (!allowed.some((a) => a !== undefined && isAddressEqual(a, input.call.to))) {
      throw new AgentBankError("invalid_request", "relayCall only targets Agent Bank contracts");
    }
    if ((input.call.value ?? 0n) !== 0n)
      throw new AgentBankError("invalid_request", "relayCall never sends native value");
    return {
      txHash: await this.relay(this.relayerFor(input.relayer), getAddress(input.call.to), input.call.data),
    };
  }

  async authorizationState(token: Address, authorizer: Address, nonce: Hex): Promise<boolean> {
    await this.ready();
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "authorizationState",
      args: [authorizer, nonce],
    });
  }

  async verifySignature(input: { address: Address; hash: Hex; signature: Hex }): Promise<boolean> {
    await this.ready();
    try {
      return await this.publicClient.verifyHash({
        address: input.address,
        hash: input.hash,
        signature: input.signature,
      });
    } catch {
      return false;
    }
  }
}
