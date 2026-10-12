import { AgentBankError } from "@agentbank/core";
import { getAddress, type Address, type Hex } from "viem";
import { disableModuleRegistryCall, policyHookInstallCalls, sessionInstallCalls } from "./calls";
import type { PolicyHookConfig, SessionGrant } from "./sessions";
import { permitCall } from "./spendKey";
import type { Call, ChainContracts } from "./types";

/** The spend key's signed provisioning permit (spender = the account, see `spendKeyPermitTypedData`). */
export interface SpendKeyPermit {
  /** The spend key (permit owner). */
  owner: Address;
  value: bigint;
  deadline: bigint;
  /** The spend key's 65-byte EIP-712 signature. */
  signature: Hex;
}

/** Input of {@link accountSetupCalls}. */
export interface AccountSetupInput {
  /** The agent account (deployed by the same owner operation when it is its first). */
  account: Address;
  contracts: ChainContracts;
  /** The first session. */
  grant: SessionGrant;
  /** Account-level AgentPolicyHook configuration (see `policyHookConfig`; include the spend key in `extraRecipients`). */
  hookConfig: PolicyHookConfig;
  /** Provision the x402 spend key: USDC `permit(spendKey → account)` for float recovery. */
  spendKeyPermit?: SpendKeyPermit;
}

/**
 * The calls of an agent account's first owner operation, in order:
 * `setRegistry(0)` (Agent Bank's modules are not registry-attested), install `AgentPolicyHook` with
 * `hookConfig`, enable the first session, and optionally submit the spend key's USDC permit.
 * The installed hook configuration always allowlists Smart Sessions and the OwnableValidator as
 * `Generic` (`policyHookInstallCalls` applies `withOwnerModules`), so later owner operations can
 * manage sessions and rotate the owner key.
 *
 * Use it for an account without a hook (normally the deploying operation): the batch executes before
 * the hook exists, so the permit is not subject to the hook (which refuses `permit` on the hooked
 * path). With a recipient allowlist, the spend key must be an allowed recipient so refills pass.
 */
export function accountSetupCalls(input: AccountSetupInput): Call[] {
  const { account, contracts, grant, hookConfig, spendKeyPermit } = input;
  if (spendKeyPermit && hookConfig.recipientAllowlistEnabled) {
    const spendKey = getAddress(spendKeyPermit.owner);
    if (!hookConfig.allowedRecipients.some((r) => getAddress(r) === spendKey)) {
      throw new AgentBankError(
        "invalid_request",
        "the spend key must be an allowed recipient of the hook (policyHookConfig extraRecipients)",
      );
    }
  }
  const calls: Call[] = [
    disableModuleRegistryCall({ account }),
    ...policyHookInstallCalls({ account, contracts, config: hookConfig }),
    ...sessionInstallCalls({ contracts, grant }),
  ];
  if (spendKeyPermit) calls.push(permitCall(contracts.usdc, { ...spendKeyPermit, spender: account }));
  return calls;
}
