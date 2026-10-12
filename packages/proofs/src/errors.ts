import type { Attribute, DisclosureClass } from "./schema";

/** A proof request (or one of its bounds) is invalid. Verifiers report it as `malformed`. */
export class ProofRequestError extends Error {
  override readonly name = "ProofRequestError";
  constructor(
    message: string,
    readonly attribute?: Attribute,
  ) {
    super(message);
  }
}

/**
 * Why the prover refused before proving:
 * - `unsatisfiable`: attested values lie outside the requested bounds;
 * - `undisclosed`: the request constrains attributes the owner did not disclose;
 * - `witness_mismatch`: the secret and the witness do not hash to the witness root;
 * - `chain_mismatch`: the witness is for another chain or registry than the request.
 */
export type ProofRefusalReason = "unsatisfiable" | "undisclosed" | "witness_mismatch" | "chain_mismatch";

/** The agent cannot (or must not) prove this request with this witness. */
export class ProofRefusedError extends Error {
  override readonly name = "ProofRefusedError";
  constructor(
    readonly reason: ProofRefusalReason,
    message: string,
    /** Attributes whose attested values are outside the requested bounds. */
    readonly attributes: readonly Attribute[] = [],
    /** Classes the request constrains that the owner did not disclose. */
    readonly undisclosedClasses: readonly DisclosureClass[] = [],
  ) {
    super(message);
  }
}

/** A witness or secret handed to the prover is malformed. */
export class ProofInputError extends Error {
  override readonly name = "ProofInputError";
}
