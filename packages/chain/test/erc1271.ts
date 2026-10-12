import {
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { encodeSessionSignature, type ChainContracts } from "../src";
import { cosigner, owner, sessionKey } from "./helpers";

/**
 * ERC-1271 signatures for an agent account, for the ADR 0001 acceptance tests: everything a session
 * key and the co-signer could try (including a well-formed ERC-7739 `TypedDataSign` request through
 * Smart Sessions), and the owner's legitimate Safe signature as a positive control.
 */

/** Safe `SafeMessage` hash an account owner signs for ERC-1271 (Safe7579 validator-zero route). */
export function safeMessageHash(chainId: number, account: Address, digest: Hex): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: account },
    types: { SafeMessage: [{ name: "message", type: "bytes" }] },
    primaryType: "SafeMessage",
    message: { message: digest },
  });
}

/** The owner's ERC-1271 signature: `address(0) ‖ ECDSA(SafeMessage)`. */
export async function ownerErc1271Signature(
  chainId: number,
  account: Address,
  digest: Hex,
  signer: PrivateKeyAccount = owner,
) {
  return concatHex([zeroAddress, await signer.sign({ hash: safeMessageHash(chainId, account, digest) })]);
}

function plus4(signature: Hex): Hex {
  const v = Number.parseInt(signature.slice(130), 16);
  return `${signature.slice(0, 130)}${(v + 4).toString(16).padStart(2, "0")}` as Hex;
}

/**
 * Session-key + co-signer ERC-1271 attempts. `digest` is the EIP-712 hash the token asks the
 * account to validate; `contents` its struct hash, `contentsType` its type string,
 * `appDomainSeparator` the token's domain separator.
 */
export async function sessionErc1271Attempts(input: {
  chainId: number;
  account: Address;
  contracts: ChainContracts;
  permissionId: Hex;
  digest: Hex;
  appDomainSeparator: Hex;
  contents: Hex;
  contentsType: string;
}): Promise<{ label: string; signature: Hex }[]> {
  const { chainId, account, contracts, permissionId, digest, appDomainSeparator, contents, contentsType } =
    input;
  const contentsName = contentsType.slice(0, contentsType.indexOf("("));
  // ERC-7739 TypedDataSign over the account's EIP-712 domain (Safe has no eip712Domain(); any values).
  const typeHash = keccak256(
    stringToHex(
      `TypedDataSign(${contentsName} contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)${contentsType}`,
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [
        typeHash,
        contents,
        keccak256(stringToHex("Safe7579")),
        keccak256(stringToHex("1.0.0")),
        BigInt(chainId),
        account,
        zeroHash,
      ],
    ),
  );
  const nestedHash = keccak256(concatHex(["0x1901", appDomainSeparator, structHash]));
  const erc7739Tail = concatHex([
    appDomainSeparator,
    contents,
    stringToHex(contentsType),
    toHex(contentsType.length, { size: 2 }),
  ]);
  const [s7739, c7739] = [
    await sessionKey.sign({ hash: nestedHash }),
    await cosigner.sign({ hash: nestedHash }),
  ];
  const [sRaw, cRaw] = [await sessionKey.sign({ hash: digest }), await cosigner.sign({ hash: digest })];
  const safeHash = safeMessageHash(chainId, account, digest);
  const [sSafe, cSafe] = [await sessionKey.sign({ hash: safeHash }), await cosigner.sign({ hash: safeHash })];
  return [
    {
      label: "Smart Sessions ERC-7739 TypedDataSign, 2-of-2 raw",
      signature: concatHex([contracts.smartSessions, permissionId, s7739, c7739, erc7739Tail]),
    },
    {
      label: "Smart Sessions ERC-7739 TypedDataSign, 2-of-2 EIP-191",
      signature: concatHex([contracts.smartSessions, permissionId, plus4(s7739), plus4(c7739), erc7739Tail]),
    },
    {
      label: "Smart Sessions USE-style signature over the digest",
      signature: concatHex([
        contracts.smartSessions,
        `0x${encodeSessionSignature({ permissionId, sessionSignature: sRaw, cosignerSignature: cRaw }).slice(4)}` as Hex,
      ]),
    },
    {
      label: "OwnableValidator route, session + co-signer",
      signature: concatHex([contracts.ownableValidator, sRaw, cRaw]),
    },
    { label: "Safe owners route, session + co-signer", signature: concatHex([zeroAddress, sSafe, cSafe]) },
    { label: "Safe owners route, co-signer", signature: concatHex([zeroAddress, cSafe]) },
  ];
}
