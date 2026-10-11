import { recoverMessageAddress, sha256, type Address, type Hex } from "viem";
import { AgentBankError } from "./errors";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8,
} from "./encoding";

/**
 * HTTP Message Signatures (RFC 9421) for agent requests, signed with the
 * agent's secp256k1 session key.
 *
 * - Covered components: `@method`, `@target-uri`, plus `content-digest`
 *   (RFC 9530, required when there is a body) and `idempotency-key` when sent.
 * - Algorithm `eip191-secp256k1`: the signature base is signed as an EIP-191
 *   personal message, so any Ethereum signer (viem, eth-account, KMS) can
 *   produce it. RFC 9421 permits application-defined algorithms when the
 *   verifier knows the key; ours is identified by the session id in `keyid`.
 * - Signatures are short-lived (`expires` ≤ 5 minutes after `created`) and
 *   carry a random `nonce` that verifiers reject on reuse.
 */

export const SIGNATURE_ALGORITHM = "eip191-secp256k1";
export const SIGNATURE_LABEL = "agentbank";
export const SIGNATURE_TAG = "agentbank";
export const MAX_SIGNATURE_LIFETIME_SECONDS = 300;
export const MAX_CLOCK_SKEW_SECONDS = 30;

export interface MessageSigner {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
}

export interface SignableRequest {
  method: string;
  /** Absolute URL including scheme, host, path and query. */
  url: string;
  headers: Record<string, string | undefined>;
  body?: string | Uint8Array | null;
}

export interface SignOptions {
  keyId: string;
  signer: MessageSigner;
  /** Unix seconds; defaults to now. */
  created?: number;
  lifetimeSeconds?: number;
  nonce?: string;
}

export interface SignedHeaders {
  [header: string]: string | undefined;
  "signature-input": string;
  signature: string;
  "content-digest"?: string;
}

export function contentDigest(body: string | Uint8Array): string {
  const bytes = typeof body === "string" ? utf8(body) : body;
  return `sha-256=:${bytesToBase64(hexToBytes(sha256(bytes)))}:`;
}

function lowerHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k.toLowerCase()] = v;
  return out;
}

function hasBody(body: SignableRequest["body"]): body is string | Uint8Array {
  return body !== undefined && body !== null && body.length > 0;
}

interface SignatureParams {
  components: string[];
  created: number;
  expires: number;
  nonce: string;
  keyid: string;
  alg: string;
  tag: string;
}

function serializeParams(p: SignatureParams): string {
  const list = `(${p.components.map((c) => `"${c}"`).join(" ")})`;
  return `${list};created=${p.created};expires=${p.expires};nonce="${p.nonce}";keyid="${p.keyid}";alg="${p.alg}";tag="${p.tag}"`;
}

function componentValue(
  component: string,
  request: SignableRequest,
  headers: Record<string, string>,
): string {
  switch (component) {
    case "@method":
      return request.method.toUpperCase();
    case "@target-uri":
      return new URL(request.url).toString();
    default: {
      const value = headers[component];
      if (value === undefined) {
        throw new AgentBankError("signature_invalid", `Covered header "${component}" is missing`);
      }
      return value.trim();
    }
  }
}

/** Build the RFC 9421 signature base for a request and serialized params. */
export function signatureBase(request: SignableRequest, params: SignatureParams): string {
  const headers = lowerHeaders(request.headers);
  const lines = params.components.map((c) => `"${c}": ${componentValue(c, request, headers)}`);
  lines.push(`"@signature-params": ${serializeParams(params)}`);
  return lines.join("\n");
}

/** Sign a request; returns headers to merge into the outgoing request. */
export async function signRequest(request: SignableRequest, options: SignOptions): Promise<SignedHeaders> {
  const headers = lowerHeaders(request.headers);
  const out: Partial<SignedHeaders> = {};
  const components = ["@method", "@target-uri"];
  if (hasBody(request.body)) {
    const digest = contentDigest(request.body);
    headers["content-digest"] = digest;
    out["content-digest"] = digest;
    components.push("content-digest");
  }
  if (headers["idempotency-key"] !== undefined) components.push("idempotency-key");

  const created = options.created ?? Math.floor(Date.now() / 1000);
  const lifetime = Math.min(options.lifetimeSeconds ?? 120, MAX_SIGNATURE_LIFETIME_SECONDS);
  const params: SignatureParams = {
    components,
    created,
    expires: created + lifetime,
    nonce: options.nonce ?? bytesToBase64Url(randomBytes(16)),
    keyid: options.keyId,
    alg: SIGNATURE_ALGORITHM,
    tag: SIGNATURE_TAG,
  };
  const base = signatureBase({ ...request, headers }, params);
  const signature = await options.signer.signMessage({ message: base });
  out["signature-input"] = `${SIGNATURE_LABEL}=${serializeParams(params)}`;
  out.signature = `${SIGNATURE_LABEL}=:${bytesToBase64(hexToBytes(signature))}:`;
  return out as SignedHeaders;
}

const INPUT_RE = /^([a-z][a-z0-9_-]*)=\(([^)]*)\)((?:;[a-z]+=(?:"[^"]*"|[0-9]+))*)$/;
const PARAM_RE = /;([a-z]+)=("[^"]*"|[0-9]+)/g;
const SIG_RE = /^([a-z][a-z0-9_-]*)=:([A-Za-z0-9+/=]+):$/;

/** Parse our Signature-Input dialect. Exported for tests and diagnostics. */
export function parseSignatureInput(value: string): { label: string; params: SignatureParams } {
  const match = INPUT_RE.exec(value.trim());
  if (!match) throw new AgentBankError("signature_invalid", "Malformed Signature-Input header");
  const [, label = "", list = "", rawParams = ""] = match;
  const components = list
    .split(" ")
    .filter((s) => s.length > 0)
    .map((s) => {
      if (!/^"[^"]+"$/.test(s)) throw new AgentBankError("signature_invalid", "Malformed component list");
      return s.slice(1, -1);
    });
  const raw: Record<string, string> = {};
  for (const m of rawParams.matchAll(PARAM_RE)) {
    const [, name = "", v = ""] = m;
    raw[name] = v.startsWith('"') ? v.slice(1, -1) : v;
  }
  const required = ["created", "expires", "nonce", "keyid", "alg"] as const;
  for (const name of required) {
    if (raw[name] === undefined)
      throw new AgentBankError("signature_invalid", `Signature-Input missing "${name}"`);
  }
  return {
    label,
    params: {
      components,
      created: Number(raw.created),
      expires: Number(raw.expires),
      nonce: raw.nonce ?? "",
      keyid: raw.keyid ?? "",
      alg: raw.alg ?? "",
      tag: raw.tag ?? "",
    },
  };
}

export interface VerifyOptions {
  /** Resolve the session key address for a keyid; return undefined if unknown. */
  resolveKey(keyId: string): Promise<Address | undefined>;
  /** Return true if this (keyid, nonce) was seen before; implementations must record it. */
  checkAndStoreNonce?(keyId: string, nonce: string, expires: number): Promise<boolean>;
  /** Unix seconds; defaults to now. */
  now?: number;
}

export interface VerifiedSignature {
  keyId: string;
  address: Address;
  created: number;
  expires: number;
  nonce: string;
  coveredComponents: string[];
}

/** Verify a signed request. Throws `signature_invalid` with a precise reason. */
export async function verifyRequest(
  request: SignableRequest,
  options: VerifyOptions,
): Promise<VerifiedSignature> {
  const headers = lowerHeaders(request.headers);
  const inputHeader = headers["signature-input"];
  const signatureHeader = headers.signature;
  if (!inputHeader || !signatureHeader) {
    throw new AgentBankError("unauthorized", "Missing Signature-Input or Signature header");
  }
  const { label, params } = parseSignatureInput(inputHeader);
  const sigMatch = SIG_RE.exec(signatureHeader.trim());
  if (!sigMatch || sigMatch[1] !== label) {
    throw new AgentBankError("signature_invalid", "Malformed Signature header");
  }
  if (params.alg !== SIGNATURE_ALGORITHM) {
    throw new AgentBankError("signature_invalid", `Unsupported algorithm "${params.alg}"`);
  }
  for (const required of ["@method", "@target-uri"]) {
    if (!params.components.includes(required)) {
      throw new AgentBankError("signature_invalid", `Signature must cover ${required}`);
    }
  }
  if (hasBody(request.body)) {
    if (!params.components.includes("content-digest")) {
      throw new AgentBankError(
        "signature_invalid",
        "Signature must cover content-digest when a body is sent",
      );
    }
    if (headers["content-digest"] !== contentDigest(request.body)) {
      throw new AgentBankError("signature_invalid", "Content-Digest does not match the body");
    }
  }
  if (headers["idempotency-key"] !== undefined && !params.components.includes("idempotency-key")) {
    throw new AgentBankError("signature_invalid", "Signature must cover idempotency-key when sent");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (params.created > now + MAX_CLOCK_SKEW_SECONDS) {
    throw new AgentBankError("signature_invalid", "Signature created in the future");
  }
  if (now > params.expires) throw new AgentBankError("signature_invalid", "Signature expired");
  if (params.expires - params.created > MAX_SIGNATURE_LIFETIME_SECONDS) {
    throw new AgentBankError("signature_invalid", "Signature lifetime exceeds 300 seconds");
  }

  const expected = await options.resolveKey(params.keyid);
  if (!expected) throw new AgentBankError("unauthorized", `Unknown key "${params.keyid}"`);

  const base = signatureBase({ ...request, headers }, params);
  const signature = bytesToHex(base64ToBytes(sigMatch[2] ?? ""));
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message: base, signature });
  } catch {
    throw new AgentBankError("signature_invalid", "Signature could not be recovered");
  }
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    throw new AgentBankError("signature_invalid", "Signature was not produced by the session key");
  }
  if (
    options.checkAndStoreNonce &&
    (await options.checkAndStoreNonce(params.keyid, params.nonce, params.expires))
  ) {
    throw new AgentBankError("signature_invalid", "Signature nonce was already used");
  }
  return {
    keyId: params.keyid,
    address: recovered,
    created: params.created,
    expires: params.expires,
    nonce: params.nonce,
    coveredComponents: params.components,
  };
}
