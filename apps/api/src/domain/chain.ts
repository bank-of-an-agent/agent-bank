import {
  accountSetupCalls,
  permitCall,
  policyHookConfig,
  spendKeyPermitTypedData,
  policyHookInstallCalls,
  sessionInstallCalls,
  type Call,
  type OnchainSessionScope,
  type PreparedOperation,
  type SessionGrant,
  type SpendKeyPermit as ChainSpendKeyPermit,
} from "@agentbank/chain";
import { AgentBankError, getAsset, isAgentBankError } from "@agentbank/core";
import {
  getAddress,
  keccak256,
  maxUint256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { AccountRow, SpendKeyPermit } from "../db/rows";
import type { AppDeps } from "../deps";
import { escrowFee } from "./billing";

/**
 * Small helpers around the ChainGateway. Chain failures surface as `chain_error` (502);
 * nothing is retried here (callers decide), and nothing here can sign: the API never holds a
 * key that can move funds.
 */

const cosignerAddressCache = new WeakMap<object, Address>();

/** The co-signer's address (configured, or reported by the co-signer's health endpoint). */
export async function cosignerAddress(deps: AppDeps): Promise<Address> {
  if (deps.config.cosigner.address) return getAddress(deps.config.cosigner.address);
  const cached = cosignerAddressCache.get(deps.cosigner);
  if (cached) return cached;
  const health = await deps.cosigner.health();
  const address = getAddress(health.cosigner_address);
  cosignerAddressCache.set(deps.cosigner, address);
  return address;
}

/** USDC on the configured chain (the gateway's token wins over the static registry). */
export function usdcAddress(deps: AppDeps): Address {
  const fromChain = (deps.chain.contracts as { usdc?: Address } | undefined)?.usdc;
  return getAddress(fromChain ?? getAsset(deps.config.chain.id, "USDC").address);
}

/** EIP-712 domain of the settlement asset (EIP-3009 `TransferWithAuthorization`). */
export function usdcDomain(deps: AppDeps) {
  const asset = getAsset(deps.config.chain.id, "USDC");
  return {
    name: asset.eip712.name,
    version: asset.eip712.version,
    chainId: deps.config.chain.id,
    verifyingContract: usdcAddress(deps),
  };
}

/** Deterministic CREATE2 salt for an account: the same agent and chain always map to one address. */
export function accountSalt(kind: "agent" | "treasury", ownerId: string, chainId: number): bigint {
  return BigInt(keccak256(stringToHex(`agentbank:${kind}-account:${ownerId}:${chainId}`)));
}

/** Run a chain call; anything but an AgentBankError becomes `chain_error`. */
export async function onChain<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAgentBankError(error)) throw error;
    throw new AgentBankError(
      "chain_error",
      `${what} failed: ${(error as Error)?.message ?? "unknown error"}`.slice(0, 300),
    );
  }
}

/** Contract address of an Agent Bank contract on this chain, or `feature_gated` style refusal. */
export function contractAddress(
  deps: AppDeps,
  name: "escrow" | "streams" | "vaults" | "topUpExecutor" | "sweepExecutor",
): Address {
  const contracts = deps.chain.contracts as unknown as Record<string, Address | undefined>;
  const address = contracts[name];
  if (!address) {
    throw new AgentBankError(
      "unsupported_chain",
      `The ${name} contract is not deployed on ${deps.config.chain.displayName}`,
    );
  }
  return getAddress(address);
}

/** A stored prepared operation (JSON) back as the gateway's type. */
export function asPrepared(json: unknown): PreparedOperation {
  return json as PreparedOperation;
}

export function hexOf(value: string): Hex {
  return value as Hex;
}

/**
 * `AgentPolicyHook` configuration for an agent account from the session scope being installed.
 * The hook sums every outflow of the token in one operation, fees included, so its caps get fee
 * headroom (the largest fee rule: escrow, 1% with a $1 minimum). The revenue address (batched
 * fees) and the agent's spend key (refills) are extra allowed recipients; the account's own
 * savings contract (TimeLockVaults) stays callable for owner operations.
 */
export function hookConfigFor(deps: AppDeps, account: AccountRow, scope: OnchainSessionScope) {
  const contracts = deps.chain.contracts as unknown as Record<string, Address | undefined>;
  const allowed = new Set(scope.allowedContracts.map((a) => getAddress(a)));
  if (contracts.vaults) allowed.add(getAddress(contracts.vaults));
  const extra: Address[] = [getAddress(deps.config.revenueAddress)];
  if (account.spend_key_address) extra.push(getAddress(account.spend_key_address));
  return policyHookConfig(
    {
      token: scope.token,
      maxPerTx: scope.maxPerTx + escrowFee(scope.maxPerTx),
      maxPerDay: scope.maxPerDay + escrowFee(scope.maxPerDay),
      allowedRecipients: scope.allowedRecipients,
      allowedContracts: [...allowed],
    },
    deps.chain.contracts,
    { extraRecipients: extra },
  );
}

/**
 * Check an EIP-2612 permit from the spend key to the account: USDC's EIP-712 `Permit`
 * (owner = spend key, spender = account, value, nonce, deadline; `spendKeyPermitTypedData`) must
 * recover to the spend key, and the deadline must outlast an owner operation. The nonce is the
 * one the client signed with (`USDC.nonces(spend key)`, 0 for a fresh key): the gateway has no
 * read for it, so a stale nonce only shows when the permit executes. Throws `invalid_request`.
 */
export async function verifySpendKeyPermit(
  deps: AppDeps,
  input: { spendKey: Address; account: Address; permit: SpendKeyPermit; now: Date },
): Promise<void> {
  const value = BigInt(input.permit.value);
  const deadline = BigInt(input.permit.deadline);
  const nonce = BigInt(input.permit.nonce);
  if (value === 0n || value > maxUint256) {
    throw new AgentBankError("invalid_request", "permit.value must be a positive uint256");
  }
  if (nonce > maxUint256) throw new AgentBankError("invalid_request", "permit.nonce must be a uint256");
  const lastsUntil = BigInt(Math.floor(input.now.getTime() / 1000) + deps.config.ownerOperationTtlSeconds);
  if (deadline > maxUint256 || deadline <= lastsUntil) {
    throw new AgentBankError(
      "invalid_request",
      "permit.deadline must outlast the setup operation (use a far-future deadline)",
    );
  }
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      ...spendKeyPermitTypedData({
        chainId: deps.config.chain.id,
        token: usdcAddress(deps),
        owner: input.spendKey,
        spender: input.account,
        value,
        nonce,
        deadline,
      }),
      signature: input.permit.signature as Hex,
    });
  } catch {
    throw new AgentBankError("invalid_request", "permit.signature is not a valid signature");
  }
  if (signer.toLowerCase() !== input.spendKey.toLowerCase()) {
    throw new AgentBankError(
      "invalid_request",
      "The permit must be signed by the spend key (EIP-2612 Permit with spender = the account)",
    );
  }
}

/** The stored permit in the chain package's shape (spender = the account). */
export function chainPermit(account: AccountRow): ChainSpendKeyPermit | undefined {
  const permit = account.spend_key_permit;
  if (!permit || !account.spend_key_address) return undefined;
  return {
    owner: getAddress(account.spend_key_address),
    value: BigInt(permit.value),
    deadline: BigInt(permit.deadline),
    signature: permit.signature as Hex,
  };
}

/** `USDC.permit(spendKey → account)`: anyone may submit it (used outside the setup operation). */
export function spendKeyPermitCall(deps: AppDeps, account: AccountRow): Call | null {
  const permit = chainPermit(account);
  if (!permit) return null;
  return permitCall(usdcAddress(deps), { ...permit, spender: getAddress(account.address) });
}

/**
 * Calls of a session install. The first one deploys the account and sets it up in the same
 * owner operation (`accountSetupCalls`): ERC-7484 registry checks off (Agent Bank's modules are
 * not attested), the AgentPolicyHook, the session, then the spend key's pending EIP-2612 permit
 * (ADR 0001; it runs before the hook exists, which refuses `permit` once installed). Later
 * installs reinstall the hook with the new scope (which also restarts its UTC-day window) and
 * enable the session.
 */
export async function sessionSetupCalls(
  deps: AppDeps,
  account: AccountRow,
  grant: SessionGrant,
  now: Date,
): Promise<{ calls: Call[]; carriesPermit: boolean }> {
  const address = getAddress(account.address);
  const deployed = await onChain("isDeployed", () => deps.chain.isDeployed(address));
  const hookConfig = hookConfigFor(deps, account, grant.scope);
  const contracts = deps.chain.contracts;
  if (deployed) {
    return {
      calls: [
        ...policyHookInstallCalls({ account: address, contracts, config: hookConfig, replace: true }),
        ...sessionInstallCalls({ contracts, grant }),
      ],
      carriesPermit: false,
    };
  }
  const permit = account.spend_key_permit_status === "pending" ? chainPermit(account) : undefined;
  const lastsUntil = BigInt(Math.floor(now.getTime() / 1000) + deps.config.ownerOperationTtlSeconds);
  const usable = permit !== undefined && permit.deadline > lastsUntil;
  if (permit && !usable) {
    deps.logger.warn({ accountId: account.id }, "the spend key permit's deadline passed; set up without it");
  }
  return {
    calls: accountSetupCalls({
      account: address,
      contracts,
      grant,
      hookConfig,
      ...(usable ? { spendKeyPermit: permit } : {}),
    }),
    carriesPermit: usable,
  };
}
