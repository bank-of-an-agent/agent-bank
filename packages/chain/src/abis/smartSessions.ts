/**
 * Rhinestone Smart Sessions (ERC-7579 validator) subset, the OwnableValidator and the Smart Sessions
 * policies Agent Bank configures. The `Session` tuple matches the deployed Smart Sessions (with
 * `permitERC4337Paymaster`), the same layout `@rhinestone/module-sdk` 0.4 encodes.
 */

const policyData = {
  type: "tuple[]",
  components: [
    { name: "policy", type: "address" },
    { name: "initData", type: "bytes" },
  ],
} as const;

/** `Session` struct components. */
export const sessionComponents = [
  { name: "sessionValidator", type: "address" },
  { name: "sessionValidatorInitData", type: "bytes" },
  { name: "salt", type: "bytes32" },
  { name: "userOpPolicies", ...policyData },
  {
    name: "erc7739Policies",
    type: "tuple",
    components: [
      {
        name: "allowedERC7739Content",
        type: "tuple[]",
        components: [
          { name: "appDomainSeparator", type: "bytes32" },
          { name: "contentName", type: "string[]" },
        ],
      },
      { name: "erc1271Policies", ...policyData },
    ],
  },
  {
    name: "actions",
    type: "tuple[]",
    components: [
      { name: "actionTargetSelector", type: "bytes4" },
      { name: "actionTarget", type: "address" },
      { name: "actionPolicies", ...policyData },
    ],
  },
  { name: "permitERC4337Paymaster", type: "bool" },
] as const;

/** Smart Sessions functions and events Agent Bank uses (enable/remove sessions, status). */
export const smartSessionsAbi = [
  {
    type: "function",
    name: "enableSessions",
    stateMutability: "nonpayable",
    inputs: [{ name: "sessions", type: "tuple[]", components: sessionComponents }],
    outputs: [{ name: "permissionIds", type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "removeSession",
    stateMutability: "nonpayable",
    inputs: [{ name: "permissionId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isPermissionEnabled",
    stateMutability: "view",
    inputs: [
      { name: "permissionId", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isInitialized",
    stateMutability: "view",
    inputs: [{ name: "smartAccount", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getERC1271Policies",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "permissionId", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "isERC7739ContentEnabled",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "permissionId", type: "bytes32" },
      { name: "appDomainSeparator", type: "bytes32" },
      { name: "content", type: "string" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "SessionCreated",
    inputs: [
      { name: "permissionId", type: "bytes32", indexed: false },
      { name: "account", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SessionRemoved",
    inputs: [
      { name: "permissionId", type: "bytes32", indexed: false },
      { name: "smartAccount", type: "address", indexed: false },
    ],
  },
] as const;

/** OwnableValidator (stateful owner validator and stateless session validator). */
export const ownableValidatorAbi = [
  {
    type: "function",
    name: "validateSignatureWithData",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "addOwner",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "removeOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setThreshold",
    stateMutability: "nonpayable",
    inputs: [{ name: "_threshold", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "ownerCount",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "threshold",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "OwnerAdded",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "OwnerRemoved",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "ThresholdSet",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "threshold", type: "uint256", indexed: false },
    ],
  },
] as const;

/** `abi.encode(uint256 threshold, address[] owners)`: OwnableValidator install data and session validator data. */
export const ownableValidatorConfigParams = [
  { name: "threshold", type: "uint256" },
  { name: "owners", type: "address[]" },
] as const;

/** `abi.encode(address[] tokens, uint256[] limits)`: ERC20SpendingLimitPolicy init data. */
export const spendingLimitsInitParams = [
  { name: "tokens", type: "address[]" },
  { name: "limits", type: "uint256[]" },
] as const;

/** `abi.encode(ActionConfig)`: UniActionPolicy init data (16 fixed rule slots). */
export const universalActionInitParams = [
  {
    name: "config",
    type: "tuple",
    components: [
      { name: "valueLimitPerUse", type: "uint256" },
      {
        name: "paramRules",
        type: "tuple",
        components: [
          { name: "length", type: "uint256" },
          {
            name: "rules",
            type: "tuple[16]",
            components: [
              { name: "condition", type: "uint8" },
              { name: "offset", type: "uint64" },
              { name: "isLimited", type: "bool" },
              { name: "ref", type: "bytes32" },
              {
                name: "usage",
                type: "tuple",
                components: [
                  { name: "limit", type: "uint256" },
                  { name: "used", type: "uint256" },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
] as const;

/** UniActionPolicy `ParamCondition`. */
export const PARAM_CONDITION = {
  EQUAL: 0,
  GREATER_THAN: 1,
  LESS_THAN: 2,
  GREATER_THAN_OR_EQUAL: 3,
  LESS_THAN_OR_EQUAL: 4,
  NOT_EQUAL: 5,
  IN_RANGE: 6,
} as const;

/** Smart Sessions signature modes (first byte of the user operation signature). */
export const SMART_SESSION_MODE = { USE: 0x00, ENABLE: 0x01, UNSAFE_ENABLE: 0x02 } as const;
