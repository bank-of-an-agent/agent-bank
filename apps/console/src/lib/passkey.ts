import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { consolePost } from "./api/client";
import { ApiProblem } from "./api/problem";

/**
 * Passkey ceremonies, run in the browser at the console origin. Challenges
 * come from the API (`/auth/*`) through the BFF and are single-use; the API
 * verifies every assertion.
 */

interface ChallengeResponse<T> {
  challenge_id: string;
  options: T;
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

/** Turn browser WebAuthn failures into the same problem shape the API uses. */
export function passkeyProblem(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const cause =
    error instanceof WebAuthnError ? (error.cause as { name?: unknown } | undefined)?.name : undefined;
  if (
    name === "NotAllowedError" ||
    cause === "NotAllowedError" ||
    (error instanceof WebAuthnError && error.code === "ERROR_CEREMONY_ABORTED")
  ) {
    return new ApiProblem({
      status: 0,
      code: "passkey_cancelled",
      title: "Passkey request cancelled",
      detail: "The passkey prompt was dismissed or timed out. Try again when you are ready.",
    });
  }
  if (
    name === "InvalidStateError" ||
    cause === "InvalidStateError" ||
    (error instanceof WebAuthnError && error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")
  ) {
    return new ApiProblem({
      status: 0,
      code: "passkey_exists",
      title: "Passkey already registered",
      detail: "This authenticator already holds a passkey for your account.",
    });
  }
  return new ApiProblem({
    status: 0,
    code: "passkey_error",
    title: "Passkey failed",
    detail: error instanceof Error ? error.message : "The browser could not complete the passkey request.",
  });
}

export interface SignedInView {
  member: { id: string; email: string; role: string };
  org: { id: string; legal_name: string };
  expires_at: string;
}

export async function signInWithPasskey(email?: string): Promise<SignedInView> {
  const { challenge_id, options } = await consolePost<
    ChallengeResponse<PublicKeyCredentialRequestOptionsJSON>
  >("/api/auth/passkey/login/options", email ? { email } : {});
  let response: AuthenticationResponseJSON;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (error) {
    throw passkeyProblem(error);
  }
  return consolePost<SignedInView>("/api/auth/passkey/login/verify", { challenge_id, response });
}

export async function registerPasskey(inviteToken?: string): Promise<SignedInView> {
  const { challenge_id, options } = await consolePost<
    ChallengeResponse<PublicKeyCredentialCreationOptionsJSON>
  >("/api/auth/passkey/register/options", inviteToken ? { invite_token: inviteToken } : {});
  let response: RegistrationResponseJSON;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (error) {
    throw passkeyProblem(error);
  }
  return consolePost<SignedInView>("/api/auth/passkey/register/verify", { challenge_id, response });
}

/** A passkey assertion for one approval decision (`DecideApprovalRequest.webauthn_assertion`). */
export async function approvalAssertion(
  approvalId: string,
  decision: "approve" | "deny",
): Promise<Record<string, unknown>> {
  const { options } = await consolePost<ChallengeResponse<PublicKeyCredentialRequestOptionsJSON>>(
    `/api/auth/approvals/${encodeURIComponent(approvalId)}/options`,
    { decision },
  );
  try {
    return (await startAuthentication({ optionsJSON: options })) as unknown as Record<string, unknown>;
  } catch (error) {
    throw passkeyProblem(error);
  }
}
