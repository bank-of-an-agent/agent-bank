import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  getAddress,
  maxUint256,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  assertRelayableCall,
  decodeCall,
  erc20Abi,
  escrowRefundCall,
  ownerRotationCalls,
  ownableValidatorAbi,
  PERMIT_SELECTORS,
  permitCall,
  safeAbi,
  safeNativeOwnerSyncCalls,
  SENTINEL_OWNERS,
  SIMULATED_CONTRACTS as C,
  transferCall,
} from "../src";
import { otherPayee, owner, payee, revenue, stranger } from "./helpers";

const account = getAddress("0x00000000000000000000000000000000000a11ce");
const newOwner = stranger.address;

describe("ownerRotationCalls", () => {
  it("swaps the Safe owner, then adds the new validator owner before removing the current one", () => {
    const calls = ownerRotationCalls({ account, contracts: C, currentOwner: owner.address, newOwner });
    expect(calls).toEqual([
      {
        to: account,
        data: encodeFunctionData({
          abi: safeAbi,
          functionName: "swapOwner",
          args: [SENTINEL_OWNERS, owner.address, newOwner],
        }),
      },
      {
        to: C.ownableValidator,
        data: encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [newOwner] }),
      },
      {
        // addOwner inserts at the head: [newOwner, owner], so owner's predecessor is newOwner.
        to: C.ownableValidator,
        data: encodeFunctionData({
          abi: ownableValidatorAbi,
          functionName: "removeOwner",
          args: [newOwner, owner.address],
        }),
      },
    ]);
    const decoded = calls.map((c) => decodeCall(c, { contracts: C, account }));
    expect(decoded.map((d) => d.kind)).toEqual(["module_config", "module_config", "module_config"]);
    expect(decoded.map((d) => d.args)).toEqual([
      {
        module: "Safe",
        function: "swapOwner",
        prevOwner: SENTINEL_OWNERS,
        oldOwner: owner.address,
        newOwner,
      },
      { module: "OwnableValidator", function: "addOwner", owner: newOwner },
      { module: "OwnableValidator", function: "removeOwner", prevOwner: newOwner, owner: owner.address },
    ]);
  });

  it("uses the given owner lists for the linked-list predecessors", () => {
    const calls = ownerRotationCalls({
      account,
      contracts: C,
      currentOwner: owner.address,
      newOwner,
      safeOwners: [payee, owner.address],
      validatorOwners: [revenue, owner.address],
    });
    const decoded = calls.map((c) => decodeCall(c, { contracts: C, account }).args);
    expect(decoded[0]).toMatchObject({ prevOwner: payee, oldOwner: owner.address });
    // After addOwner: [newOwner, revenue, owner].
    expect(decoded[2]).toMatchObject({ prevOwner: revenue, owner: owner.address });
  });

  it("refuses invalid rotations", () => {
    const base = { account, contracts: C, currentOwner: owner.address };
    for (const bad of [zeroAddress, SENTINEL_OWNERS, account]) {
      expect(() => ownerRotationCalls({ ...base, newOwner: bad })).toThrow(/newOwner is not a valid owner/);
    }
    expect(() => ownerRotationCalls({ ...base, newOwner: owner.address })).toThrow(/equals currentOwner/);
    expect(() => ownerRotationCalls({ ...base, newOwner, safeOwners: [owner.address, newOwner] })).toThrow(
      /already an owner/,
    );
    expect(() => ownerRotationCalls({ ...base, newOwner, safeOwners: [payee] })).toThrow(
      /not in the Safe owners/,
    );
    expect(() => ownerRotationCalls({ ...base, newOwner, validatorOwners: [payee] })).toThrow(
      /not in the OwnableValidator owners/,
    );
  });
});

describe("safeNativeOwnerSyncCalls", () => {
  const add = (o: Address) => ({
    to: C.ownableValidator,
    data: encodeFunctionData({ abi: ownableValidatorAbi, functionName: "addOwner", args: [o] }),
  });
  const remove = (prev: Address, o: Address) => ({
    to: C.ownableValidator,
    data: encodeFunctionData({ abi: ownableValidatorAbi, functionName: "removeOwner", args: [prev, o] }),
  });

  it("re-keys the validator after a Safe-only owner change: add first, then remove", () => {
    expect(
      safeNativeOwnerSyncCalls({
        account,
        contracts: C,
        owners: { safe: [newOwner], validator: [owner.address] },
      }),
    ).toEqual([add(newOwner), remove(newOwner, owner.address)]);
  });

  it("is empty when the records agree and tracks predecessors across several changes", () => {
    expect(
      safeNativeOwnerSyncCalls({
        account,
        contracts: C,
        owners: { safe: [owner.address], validator: [owner.address] },
      }),
    ).toEqual([]);
    // validator [payee, owner] -> add newOwner, otherPayee -> [otherPayee, newOwner, payee, owner]
    expect(
      safeNativeOwnerSyncCalls({
        account,
        contracts: C,
        owners: { safe: [owner.address, newOwner, otherPayee], validator: [payee, owner.address] },
      }),
    ).toEqual([add(newOwner), add(otherPayee), remove(newOwner, payee)]);
  });

  it("refuses an empty or invalid Safe owner set", () => {
    expect(() =>
      safeNativeOwnerSyncCalls({ account, contracts: C, owners: { safe: [], validator: [owner.address] } }),
    ).toThrow(/must have an owner/);
    expect(() =>
      safeNativeOwnerSyncCalls({ account, contracts: C, owners: { safe: [account], validator: [] } }),
    ).toThrow(/not a valid owner/);
    expect(() =>
      safeNativeOwnerSyncCalls({ account, contracts: C, owners: { safe: [newOwner], validator: [] } }),
    ).toThrow(/OwnableValidator has no owners/);
  });
});

describe("relayable calls", () => {
  const permitArgs = {
    owner: payee,
    spender: account,
    value: maxUint256,
    deadline: maxUint256,
  };

  it("relays Agent Bank contract calls and USDC permit (both overloads) only", () => {
    expect(PERMIT_SELECTORS).toEqual([
      toFunctionSelector("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"),
      toFunctionSelector("permit(address,address,uint256,uint256,bytes)"),
    ]);
    assertRelayableCall(escrowRefundCall({ escrow: C.escrow as Address, escrowId: 1n }), C);
    const vrs = permitCall(C.usdc, { ...permitArgs, signature: `0x${"11".repeat(64)}1b` as Hex });
    const bytes = permitCall(C.usdc, { ...permitArgs, signature: `0x${"22".repeat(70)}` as Hex });
    expect([vrs.data.slice(0, 10), bytes.data.slice(0, 10)]).toEqual(PERMIT_SELECTORS);
    assertRelayableCall(vrs, C);
    assertRelayableCall(bytes, C);
  });

  it("refuses other USDC functions, other targets and native value", () => {
    const refuse = (call: { to: Address; data: Hex; value?: bigint }, message: RegExp) =>
      expect(() => assertRelayableCall(call, C)).toThrow(message);
    refuse(transferCall({ token: C.usdc, to: payee, amount: 1n }), /only relays USDC permit/);
    refuse(
      {
        to: C.usdc,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [payee, 1n] }),
      },
      /only relays USDC permit/,
    );
    refuse({ to: C.usdc, data: "0x" }, /only relays USDC permit/);
    // A permit selector aimed at another token is not relayed.
    refuse({ ...permitCall(payee, { ...permitArgs, signature: `0x${"11".repeat(64)}1b` }) }, /only targets/);
    refuse({ to: C.ownableValidator, data: "0x" }, /only targets/);
    refuse({ ...escrowRefundCall({ escrow: C.escrow as Address, escrowId: 1n }), value: 1n }, /native value/);
    const thrown = (() => {
      try {
        assertRelayableCall({ to: C.usdc, data: "0x" }, C);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toMatchObject({ code: "invalid_request" });
  });
});
