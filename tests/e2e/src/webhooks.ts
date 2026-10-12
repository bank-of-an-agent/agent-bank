import {
  verifyWebhook,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "@agentbank/sdk";
import { readBody, serve, type HttpServer } from "./net";

/**
 * A webhook endpoint the stack's API delivers to over real HTTP. Every delivery is recorded
 * with its raw body; `verifiedWith(secret)` checks the `AgentBank-Signature` HMAC with the
 * SDK's `verifyWebhook`, exactly as a customer's receiver would.
 */

export interface WebhookDelivery {
  /** `AgentBank-Delivery` header. */
  id: string;
  /** `AgentBank-Event` header. */
  type: string;
  signature: string;
  rawBody: string;
  body: { id: string; type: string; org_id: string; data: Record<string, unknown> };
  receivedAt: Date;
  path: string;
}

export class WebhookReceiver {
  /** Status the receiver answers with (set to 500 to exercise retries). */
  get status(): number {
    return this.control.status;
  }
  set status(value: number) {
    this.control.status = value;
  }

  private constructor(
    private readonly server: HttpServer,
    readonly deliveries: WebhookDelivery[],
    private readonly control: { status: number },
  ) {}

  static async start(port = 0): Promise<WebhookReceiver> {
    const deliveries: WebhookDelivery[] = [];
    const control = { status: 200 };
    const server = await serve((req, res) => {
      void readBody(req).then((raw) => {
        const header = (name: string) => {
          const v = req.headers[name];
          return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
        };
        let body: WebhookDelivery["body"];
        try {
          body = JSON.parse(raw) as WebhookDelivery["body"];
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        deliveries.push({
          id: header(WEBHOOK_ID_HEADER),
          type: header(WEBHOOK_EVENT_HEADER),
          signature: header(WEBHOOK_SIGNATURE_HEADER),
          rawBody: raw,
          body,
          receivedAt: new Date(),
          path: req.url ?? "/",
        });
        res.statusCode = control.status;
        res.end();
      });
    }, port);
    return new WebhookReceiver(server, deliveries, control);
  }

  /** URL for one endpoint (one path per org keeps deliveries apart). */
  url(path = "/hooks"): string {
    return `${this.server.url}${path}`;
  }

  /** Deliveries to `path`, optionally of one event type. */
  received(path: string, type?: string): WebhookDelivery[] {
    return this.deliveries.filter((d) => d.path === path && (type === undefined || d.type === type));
  }

  /**
   * Whether a delivery's signature verifies with `secret` (SDK `verifyWebhook`, tolerance 300 s
   * around the delivery time).
   */
  static verifies(delivery: WebhookDelivery, secret: string): boolean {
    try {
      verifyWebhook(secret, delivery.rawBody, delivery.signature, {
        now: Math.floor(delivery.receivedAt.getTime() / 1000),
      });
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
