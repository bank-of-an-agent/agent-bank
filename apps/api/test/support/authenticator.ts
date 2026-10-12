import { isoCBOR } from "@simplewebauthn/server/helpers";
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

/**
 * A software WebAuthn authenticator (ES256, "none" attestation, user verification) for
 * exercising the console's passkey ceremonies end to end in tests.
 */

const b64url = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private counter = 0;

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x as string, "base64url");
    this.y = Buffer.from(jwk.y as string, "base64url");
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private authData(flags: number, attested: boolean): Buffer {
    const parts: Buffer[] = [sha256(this.rpId), Buffer.from([flags])];
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    parts.push(count);
    if (attested) {
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(this.x)],
          [-3, new Uint8Array(this.y)],
        ]),
      );
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, Buffer.from(cose));
    }
    return Buffer.concat(parts);
  }

  /** `navigator.credentials.create()` result for registration options. */
  register(options: { challenge: string }): Record<string, unknown> {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const authData = this.authData(0x45, true); // UP | UV | AT
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** `navigator.credentials.get()` result for authentication options. */
  authenticate(options: { challenge: string }): Record<string, unknown> {
    this.counter += 1;
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const authenticatorData = this.authData(0x05, false); // UP | UV
    const signer = createSign("sha256");
    signer.update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
    const signature = signer.sign(this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}
