import type { Handlers } from "../http/registry";
import { accountHandlers } from "./accounts";
import { agentHandlers } from "./agents";
import { approvalHandlers } from "./approvals";
import { authorityHandlers } from "./authority";
import { billingHandlers } from "./billing";
import { escrowHandlers } from "./escrows";
import { ledgerHandlers } from "./ledger";
import { metaHandlers } from "./meta";
import { orgHandlers } from "./orgs";
import { paymentHandlers } from "./payments";
import { sandboxHandlers } from "./sandbox";
import { savingsHandlers } from "./savings";
import { sessionHandlers } from "./sessions";
import { streamHandlers } from "./streams";
import { webhookHandlers } from "./webhooks";
import { x402Handlers } from "./x402";

/** Every API operation's handler. The type requires exactly one per registry route. */
export const handlers: Handlers = {
  ...orgHandlers,
  ...agentHandlers,
  ...accountHandlers,
  ...sessionHandlers,
  ...authorityHandlers,
  ...paymentHandlers,
  ...x402Handlers,
  ...escrowHandlers,
  ...streamHandlers,
  ...approvalHandlers,
  ...ledgerHandlers,
  ...savingsHandlers,
  ...webhookHandlers,
  ...billingHandlers,
  ...metaHandlers,
  ...sandboxHandlers,
};
