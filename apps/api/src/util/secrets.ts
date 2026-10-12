import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Webhook endpoint secrets must be readable by the worker (it signs with them), so they cannot
 * be hashed. With `WEBHOOK_SIGNING_KEY` set they are sealed at rest with AES-256-GCM
 * (`enc:v1:<iv>:<ciphertext+tag>`, base64url); without it (development) they are stored as is.
 */

const PREFIX = "enc:v1:";

function keyOf(material: string): Buffer {
  return createHash("sha256").update(`agentbank:webhook-secrets:${material}`, "utf8").digest();
}

export function sealSecret(secret: string, keyMaterial: string | undefined): string {
  if (!keyMaterial) return secret;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(keyMaterial), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${iv.toString("base64url")}:${body.toString("base64url")}`;
}

export function openSecret(stored: string, keyMaterial: string | undefined): string {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!keyMaterial) throw new Error("WEBHOOK_SIGNING_KEY is required to read sealed webhook secrets");
  const [ivPart, bodyPart] = stored.slice(PREFIX.length).split(":");
  const iv = Buffer.from(ivPart ?? "", "base64url");
  const body = Buffer.from(bodyPart ?? "", "base64url");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(keyMaterial), iv);
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString(
    "utf8",
  );
}
