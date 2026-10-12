import { AgentBankError, base64UrlToBytes, isAgentBankError } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MemberInviteRow, MemberRow, OrgRow, PasskeyRow, WebauthnChallengeRow } from "../db/rows";
import { all, one } from "../db/sql";
import { actorOf, audit } from "../domain/audit";
import type { AppDeps } from "../deps";
import { serializeMember, serializeOrg } from "../serializers";
import { randomToken, sha256Hex } from "../util/crypto";
import { internalId } from "../util/ids";
import { addSeconds } from "../util/time";
import { authenticatePrincipal, hasPermission, SESSION_COOKIE, type PrincipalAuth } from "./auth";
import { PROBLEM_CONTENT_TYPE, problemFor, validationError } from "./problem";

/**
 * Console sign-in with passkeys (WebAuthn), outside the v1 registry:
 *
 * | Route                                   | Who                                   | Does                                   |
 * | --------------------------------------- | ------------------------------------- | -------------------------------------- |
 * | `POST /auth/members/:id/invite`         | admin (API key or console)            | one-time invite token for a member     |
 * | `POST /auth/passkeys/register/options`  | invite token, console session, or admin API key of the member | registration options |
 * | `POST /auth/passkeys/register/verify`   | holder of the challenge               | stores the passkey, signs in (cookie)  |
 * | `POST /auth/passkeys/login/options`     | anyone                                | authentication options                 |
 * | `POST /auth/passkeys/login/verify`      | holder of a registered passkey        | signs in (cookie)                      |
 * | `GET /auth/session`                     | console session                       | current member and org                 |
 * | `POST /auth/logout`                     | console session                       | revokes the session, clears the cookie |
 * | `POST /auth/approvals/:id/options`      | approver/admin console session        | passkey challenge to decide an approval |
 *
 * The session cookie `agentbank_session` is httpOnly, SameSite=Strict, Secure outside
 * development; only its SHA-256 is stored. CORS is restricted to `CONSOLE_ORIGIN`.
 */

const CHALLENGE_TTL_SECONDS = 300;
const INVITE_TTL_SECONDS = 7 * 24 * 3600;

const RegisterOptionsBody = z.object({ invite_token: z.string().min(16).max(200).optional() }).strict();
const VerifyBody = z
  .object({ challenge_id: z.string().min(1).max(100), response: z.record(z.string(), z.unknown()) })
  .strict();
const LoginOptionsBody = z.object({ email: z.email().optional() }).strict();
const ApprovalOptionsBody = z.object({ decision: z.enum(["approve", "deny"]) }).strict();

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw validationError(result.error, "body");
  return result.data;
}

async function respond(
  request: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<{ status?: number; body: unknown }>,
): Promise<FastifyReply> {
  try {
    const { status, body } = await run();
    return reply
      .code(status ?? 200)
      .header("content-type", "application/json; charset=utf-8")
      .send(JSON.stringify(body));
  } catch (error) {
    const problem = problemFor(error, request.url.split("?")[0], request.log);
    return reply
      .code(problem.status)
      .header("content-type", `${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
      .send(JSON.stringify(problem));
  }
}

async function storeChallenge(
  db: SqlClient,
  now: Date,
  input: {
    challenge: string;
    purpose: WebauthnChallengeRow["purpose"];
    memberId: string | null;
    inviteId?: string | null;
    subject?: string | null;
  },
): Promise<string> {
  const id = internalId("wch", now);
  await db.query(
    `INSERT INTO webauthn_challenge (id, challenge, purpose, member_id, invite_id, subject, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.challenge,
      input.purpose,
      input.memberId,
      input.inviteId ?? null,
      input.subject ?? null,
      addSeconds(now, CHALLENGE_TTL_SECONDS),
      now,
    ],
  );
  return id;
}

/** Mark a challenge used; fails if it was already used or expired (single use). */
async function consumeChallenge(
  db: SqlClient,
  id: string,
  purpose: WebauthnChallengeRow["purpose"],
  now: Date,
): Promise<WebauthnChallengeRow> {
  const row = await one<WebauthnChallengeRow>(
    db,
    `UPDATE webauthn_challenge SET used_at = $3
      WHERE id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3 RETURNING *`,
    [id, purpose, now],
  );
  if (!row) throw new AgentBankError("signature_invalid", "Passkey challenge is unknown, used or expired");
  return row;
}

function webauthnCredential(passkey: PasskeyRow) {
  return {
    id: passkey.id,
    publicKey: new Uint8Array(passkey.public_key),
    counter: Number(passkey.counter),
    transports: passkey.transports,
  };
}

/** Create a console session for a member and set the cookie. */
export async function startConsoleSession(
  deps: AppDeps,
  reply: FastifyReply,
  member: MemberRow,
  now: Date,
): Promise<Date> {
  const token = randomToken(32);
  const expiresAt = addSeconds(now, deps.config.consoleSessionTtlSeconds);
  await deps.db.query(
    `INSERT INTO console_session (id, token_hash, member_id, org_id, created_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [internalId("csn", now), sha256Hex(token), member.id, member.org_id, now, expiresAt],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "strict",
    path: "/",
    maxAge: deps.config.consoleSessionTtlSeconds,
  });
  return expiresAt;
}

async function sessionView(db: SqlClient, member: MemberRow, expiresAt: Date) {
  const org = (await one<OrgRow>(db, "SELECT * FROM org WHERE id = $1", [member.org_id])) as OrgRow;
  return { member: serializeMember(member), org: serializeOrg(org), expires_at: expiresAt.toISOString() };
}

/**
 * Verify a passkey assertion made for an approval decision. The challenge must have been issued
 * to this member for exactly this approval and decision (`POST /auth/approvals/:id/options`).
 */
export async function verifyApprovalAssertion(
  deps: AppDeps,
  input: {
    memberId: string;
    approvalId: string;
    decision: "approve" | "deny";
    assertion: unknown;
    now: Date;
  },
): Promise<void> {
  const response = input.assertion as AuthenticationResponseJSON;
  let challenge: string;
  try {
    const clientData = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(response.response.clientDataJSON)),
    ) as {
      challenge?: unknown;
    };
    if (typeof clientData.challenge !== "string") throw new Error("challenge");
    challenge = clientData.challenge;
  } catch {
    throw new AgentBankError(
      "invalid_request",
      "webauthn_assertion must be a WebAuthn AuthenticationResponseJSON",
    );
  }
  const row = await one<WebauthnChallengeRow>(
    deps.db,
    `UPDATE webauthn_challenge SET used_at = $5
      WHERE challenge = $1 AND purpose = 'approval' AND member_id = $2 AND subject = $3
        AND used_at IS NULL AND expires_at > $4
      RETURNING *`,
    [challenge, input.memberId, `${input.approvalId}:${input.decision}`, input.now, input.now],
  );
  if (!row)
    throw new AgentBankError(
      "signature_invalid",
      "Approval challenge is unknown, used, expired or for another decision",
    );
  const passkey = await one<PasskeyRow>(deps.db, "SELECT * FROM passkey WHERE id = $1 AND member_id = $2", [
    response.id,
    input.memberId,
  ]);
  if (!passkey) throw new AgentBankError("signature_invalid", "Unknown passkey for this member");
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: deps.config.webauthn.origins,
      expectedRPID: deps.config.webauthn.rpId,
      credential: webauthnCredential(passkey),
      requireUserVerification: true,
    });
  } catch {
    throw new AgentBankError("signature_invalid", "Passkey assertion is invalid");
  }
  if (!verified.verified) throw new AgentBankError("signature_invalid", "Passkey assertion is invalid");
  await deps.db.query("UPDATE passkey SET counter = $2 WHERE id = $1", [
    passkey.id,
    BigInt(verified.authenticationInfo.newCounter),
  ]);
}

export function registerConsoleAuth(app: FastifyInstance, deps: AppDeps): void {
  const { rpId, rpName, origins } = deps.config.webauthn;

  app.post<{ Params: { id: string } }>("/auth/members/:id/invite", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const principal = await authenticatePrincipal(request, deps, now);
      if (!hasPermission(principal, "admin"))
        throw new AgentBankError("forbidden", "Only admins can invite members");
      const member = await one<MemberRow>(deps.db, "SELECT * FROM member WHERE id = $1 AND org_id = $2", [
        request.params.id,
        principal.orgId,
      ]);
      if (!member) throw new AgentBankError("not_found", "Member not found");
      const token = `inv_${randomToken(32)}`;
      const expiresAt = addSeconds(now, INVITE_TTL_SECONDS);
      await deps.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO member_invite (id, member_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
          [internalId("inv", now), member.id, sha256Hex(token), expiresAt, now],
        );
        await audit(tx, now, { actor: actorOf(principal), action: "member.invite", subject: member.id });
      });
      return {
        status: 201,
        body: { member_id: member.id, invite_token: token, expires_at: expiresAt.toISOString() },
      };
    }),
  );

  app.post("/auth/passkeys/register/options", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const body = parse(RegisterOptionsBody, request.body);
      let member: MemberRow | undefined;
      let inviteId: string | null = null;
      if (body.invite_token) {
        const invite = await one<MemberInviteRow>(
          deps.db,
          "SELECT * FROM member_invite WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2",
          [sha256Hex(body.invite_token), now],
        );
        if (!invite) throw new AgentBankError("unauthorized", "Invite is invalid, used or expired");
        inviteId = invite.id;
        member = await one<MemberRow>(deps.db, "SELECT * FROM member WHERE id = $1", [invite.member_id]);
      } else {
        const principal = await authenticatePrincipal(request, deps, now);
        if (!principal.memberId)
          throw new AgentBankError("forbidden", "This credential is not bound to a member");
        if (principal.via === "api_key" && !hasPermission(principal, "admin")) {
          throw new AgentBankError(
            "forbidden",
            "Registering a passkey with an API key requires the admin scope",
          );
        }
        member = await one<MemberRow>(deps.db, "SELECT * FROM member WHERE id = $1", [principal.memberId]);
      }
      if (!member) throw new AgentBankError("not_found", "Member not found");
      const existing = await all<PasskeyRow>(deps.db, "SELECT * FROM passkey WHERE member_id = $1", [
        member.id,
      ]);
      const options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        userName: member.email,
        userID: new TextEncoder().encode(member.id),
        attestationType: "none",
        excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      const challengeId = await storeChallenge(deps.db, now, {
        challenge: options.challenge,
        purpose: "register",
        memberId: member.id,
        inviteId,
      });
      return { body: { challenge_id: challengeId, options } };
    }),
  );

  app.post("/auth/passkeys/register/verify", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const body = parse(VerifyBody, request.body);
      const challenge = await consumeChallenge(deps.db, body.challenge_id, "register", now);
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.response as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origins,
          expectedRPID: rpId,
          requireUserVerification: true,
        });
      } catch {
        throw new AgentBankError("signature_invalid", "Passkey registration could not be verified");
      }
      if (!verification.verified)
        throw new AgentBankError("signature_invalid", "Passkey registration failed");
      const credential = verification.registrationInfo.credential;
      const member = await deps.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO passkey (id, member_id, public_key, counter, transports, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            credential.id,
            challenge.member_id,
            credential.publicKey,
            BigInt(credential.counter),
            credential.transports ?? [],
            now,
          ],
        );
        const row = await one<MemberRow>(
          tx,
          "UPDATE member SET passkey_ids = array_append(passkey_ids, $2) WHERE id = $1 RETURNING *",
          [challenge.member_id, credential.id],
        );
        if (challenge.invite_id) {
          await tx.query("UPDATE member_invite SET used_at = $2 WHERE id = $1", [challenge.invite_id, now]);
        }
        await audit(tx, now, {
          actor: `member:${challenge.member_id}`,
          action: "passkey.register",
          subject: credential.id,
        });
        return row as MemberRow;
      });
      const expiresAt = await startConsoleSession(deps, reply, member, now);
      return { status: 201, body: await sessionView(deps.db, member, expiresAt) };
    }),
  );

  app.post("/auth/passkeys/login/options", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const body = parse(LoginOptionsBody, request.body);
      const passkeys = body.email
        ? await all<PasskeyRow>(
            deps.db,
            "SELECT p.* FROM passkey p JOIN member m ON m.id = p.member_id WHERE m.email = $1",
            [body.email.toLowerCase()],
          )
        : [];
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        userVerification: "required",
        allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      });
      const challengeId = await storeChallenge(deps.db, now, {
        challenge: options.challenge,
        purpose: "login",
        memberId: null,
      });
      return { body: { challenge_id: challengeId, options } };
    }),
  );

  app.post("/auth/passkeys/login/verify", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const body = parse(VerifyBody, request.body);
      const challenge = await consumeChallenge(deps.db, body.challenge_id, "login", now);
      const response = body.response as unknown as AuthenticationResponseJSON;
      const passkey = await one<PasskeyRow>(deps.db, "SELECT * FROM passkey WHERE id = $1", [response.id]);
      if (!passkey) throw new AgentBankError("signature_invalid", "Unknown passkey");
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origins,
          expectedRPID: rpId,
          credential: webauthnCredential(passkey),
          requireUserVerification: true,
        });
      } catch {
        throw new AgentBankError("signature_invalid", "Passkey assertion could not be verified");
      }
      if (!verification.verified) throw new AgentBankError("signature_invalid", "Passkey assertion failed");
      await deps.db.query("UPDATE passkey SET counter = $2 WHERE id = $1", [
        passkey.id,
        BigInt(verification.authenticationInfo.newCounter),
      ]);
      const member = (await one<MemberRow>(deps.db, "SELECT * FROM member WHERE id = $1", [
        passkey.member_id,
      ])) as MemberRow;
      const expiresAt = await startConsoleSession(deps, reply, member, now);
      return { body: await sessionView(deps.db, member, expiresAt) };
    }),
  );

  app.get("/auth/session", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const token = request.cookies?.[SESSION_COOKIE];
      if (!token) throw new AgentBankError("unauthorized", "Not signed in");
      const row = await one<{ member_id: string; expires_at: Date }>(
        deps.db,
        "SELECT member_id, expires_at FROM console_session WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2",
        [sha256Hex(token), now],
      );
      if (!row) throw new AgentBankError("unauthorized", "Console session expired or invalid");
      const member = (await one<MemberRow>(deps.db, "SELECT * FROM member WHERE id = $1", [
        row.member_id,
      ])) as MemberRow;
      return { body: await sessionView(deps.db, member, row.expires_at) };
    }),
  );

  app.post("/auth/logout", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const token = request.cookies?.[SESSION_COOKIE];
      if (token) {
        await deps.db.query(
          "UPDATE console_session SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
          [sha256Hex(token), now],
        );
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { body: { ok: true } };
    }),
  );

  app.post<{ Params: { id: string } }>("/auth/approvals/:id/options", (request, reply) =>
    respond(request, reply, async () => {
      const now = deps.clock.now();
      const body = parse(ApprovalOptionsBody, request.body);
      let principal: PrincipalAuth;
      try {
        principal = await authenticatePrincipal(request, deps, now);
      } catch (error) {
        if (isAgentBankError(error)) throw error;
        throw new AgentBankError("unauthorized", "Sign in to the console first");
      }
      if (principal.via !== "console" || !principal.memberId) {
        throw new AgentBankError("forbidden", "Passkey approval challenges are for console members");
      }
      if (principal.memberRole !== "admin" && principal.memberRole !== "approver") {
        throw new AgentBankError("forbidden", "Only approvers and admins can decide approvals");
      }
      const approval = await one<{ id: string }>(
        deps.db,
        "SELECT id FROM approval WHERE id = $1 AND org_id = $2 AND status = 'pending'",
        [request.params.id, principal.orgId],
      );
      if (!approval) throw new AgentBankError("not_found", "Pending approval not found");
      const passkeys = await all<PasskeyRow>(deps.db, "SELECT * FROM passkey WHERE member_id = $1", [
        principal.memberId,
      ]);
      if (passkeys.length === 0) throw new AgentBankError("invalid_state", "Register a passkey first");
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        userVerification: "required",
        allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      });
      const challengeId = await storeChallenge(deps.db, now, {
        challenge: options.challenge,
        purpose: "approval",
        memberId: principal.memberId,
        subject: `${approval.id}:${body.decision}`,
      });
      return { body: { challenge_id: challengeId, options } };
    }),
  );
}
