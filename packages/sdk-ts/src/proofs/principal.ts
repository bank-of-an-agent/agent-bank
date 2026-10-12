import { ownerPayloads, type OwnerAction } from "@agentbank/core";
import { DISCLOSURE_CLASSES } from "@agentbank/core/api";
import type { RequestOptions } from "../client";
import { InvalidRequestError } from "../errors";
import { readOptions, writeOptions } from "../internal/options";
import { Proofs, type QueryOf, type Requester } from "../resources";
import type { OwnerSigner } from "../signers";
import type {
  DisclosureClass,
  OwnerAuthorization,
  Page,
  ProofReservation,
  ProofSettings,
  ReleaseProofReservationInput,
} from "../types";

/** Signs an owner authorization (`PrincipalClient.authorize`). */
export type OwnerAuthorizer = (
  input: { action: OwnerAction; subject: string; payload: unknown },
  owner?: OwnerSigner,
) => Promise<OwnerAuthorization>;

/** Input of {@link PrincipalProofs.configure}. */
export interface ConfigureProofsInput {
  /** Whether the agent appears in the attested tree at all. */
  enabled: boolean;
  /** Classes a proof may constrain: `principal`, `limits`, `balance`, `reservations`, `account_age`, `reputation`. */
  disclose: readonly DisclosureClass[];
}

/**
 * `PrincipalClient.proofs`: the raw Proofs operations plus the owner's flows. Disclosure is
 * the owner's decision; changes follow the policy engine's asymmetry: widening (enabling or
 * adding a class) is signed with the owner key and applies from the next root, narrowing
 * needs only the API key and revokes older roots at once.
 */
export class PrincipalProofs extends Proofs {
  readonly #authorize: OwnerAuthorizer;

  constructor(client: Requester, authorize: OwnerAuthorizer) {
    super(client);
    this.#authorize = authorize;
  }

  /** What the agent may prove (`enabled`, `disclose`, the disclosure mask). */
  settings(agentId: string, options?: RequestOptions): Promise<ProofSettings> {
    return this.retrieveSettings(agentId, options);
  }

  /**
   * Set what the agent may prove. Reads the current settings first: when the change widens
   * disclosure (enables proofs or adds a class) the owner key signs `proofs.disclose` over
   * `{ agent_id, enabled, disclose }`; a narrowing (or unchanged) setting is sent unsigned.
   */
  async configure(
    agentId: string,
    input: ConfigureProofsInput,
    options: RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<ProofSettings> {
    if (typeof input.enabled !== "boolean") {
      throw new InvalidRequestError("invalid_request", "enabled must be a boolean");
    }
    const unknown = (input.disclose ?? []).filter(
      (c) => !(DISCLOSURE_CLASSES as readonly string[]).includes(c),
    );
    if (!Array.isArray(input.disclose) || unknown.length > 0) {
      throw new InvalidRequestError(
        "invalid_request",
        `disclose must list disclosure classes (${DISCLOSURE_CLASSES.join(", ")})${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}`,
      );
    }
    // Canonical class order, as the API stores and returns it (the signed payload sorts on its own).
    const disclose = DISCLOSURE_CLASSES.filter((c) => input.disclose.includes(c));
    const current = await this.retrieveSettings(agentId, readOptions(options));
    const widens = (input.enabled && !current.enabled) || disclose.some((c) => !current.disclose.includes(c));
    const owner_authorization = widens
      ? await this.#authorize(
          ownerPayloads.proofsDisclose(agentId, { enabled: input.enabled, disclose }),
          options.owner,
        )
      : undefined;
    return this.updateSettings(
      agentId,
      { enabled: input.enabled, disclose, ...(owner_authorization ? { owner_authorization } : {}) },
      writeOptions(options),
    );
  }

  /** An account's proof-of-funds reservations, newest first. */
  reservations(
    accountId: string,
    query: QueryOf<"listProofReservations"> = {},
    options?: RequestOptions,
  ): Promise<Page<ProofReservation>> {
    return this.listReservations(accountId, query, options);
  }

  /**
   * Release a reservation before it expires: the owner key signs
   * `proofs.reservation.release` over `{ reservation_id }`. Agent Bank voids the hold and
   * revokes every root that contains it. Pass `body` to send an authorization signed
   * elsewhere instead.
   */
  override async releaseReservation(
    id: string,
    body?: ReleaseProofReservationInput,
    options: RequestOptions & { owner?: OwnerSigner } = {},
  ): Promise<ProofReservation> {
    if (body) return super.releaseReservation(id, body, writeOptions(options));
    const owner_authorization = await this.#authorize(
      ownerPayloads.proofReservationRelease(id),
      options.owner,
    );
    return super.releaseReservation(id, { owner_authorization }, writeOptions(options));
  }
}
