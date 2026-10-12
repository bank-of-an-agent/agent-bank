import { createPaywall, type Paywall } from "@agentbank/sdk/x402-server";
import { withPaywall } from "@agentbank/sdk/x402-server";
import {
  canPayPerTx,
  reputation,
  reservedFor,
  verifiedCompany,
  type VerifiedProof,
} from "@agentbank/sdk/proof-server";
import { serveWeb, type FetchLike, type HttpServer } from "./net";
import { createProofRoutes, type ProofRoutes, type ProofStats } from "./proofs";

/**
 * A demo x402 seller: two paid routes behind the SDK's `createPaywall`, served over real HTTP
 * and settled through the stack's facilitator. `/weather` costs $0.01 (settled after serving)
 * and `/report` costs $2.00 (settled before serving, above the $1 threshold). Both pay to the
 * seller's Agent Bank account, so the 0.5% receive fee accrues to it.
 *
 * With `proofs`, it also admits agents by private proofs (`@agentbank/sdk/proof-server`,
 * {@link DEMO_PROOF_ROUTES}): `/premium` (a verified company that can pay $0.05 a call, then
 * x402 $0.05), `/bid` ($25 reserved for this seller for at least 10 minutes) and `/jobs` (no lost
 * disputes). A request without a proof gets `401` with `AGENT-PROOF-REQUIRED`.
 */

/** The demo seller's proof-gated routes and what each asks the agent to prove. */
export const DEMO_PROOF_ROUTES = [
  { path: "/premium", proves: "a verified company backs it and it can pay $0.05 a call; then x402 $0.05" },
  { path: "/bid", proves: "$25.00 is reserved for this seller for at least 10 more minutes" },
  { path: "/jobs", proves: "escrows completed >= 0 and no lost disputes" },
] as const;

export interface DemoSellerProofOptions {
  /** Agent Bank's API: roots are resolved through `GET /v1/proofs/roots/{root}`. */
  apiUrl: string;
  /** The scope agents prove to: the host name they reach the seller at (e.g. `localhost`). */
  scope: string;
  /** `min_anonymity_set` of the requests (16 in real deployments; small sandboxes need less). */
  minAnonymitySet: number;
  stats?: ProofStats;
}

export interface DemoSellerOptions {
  facilitatorUrl: string;
  /** The seller's Agent Bank account address (x402 `payTo`). */
  payTo: string;
  /** CAIP-2 network (default eip155:1337, the simulated chain). */
  network?: string;
  /** `fetch` the paywall uses to reach the facilitator (resolves test hosts to local servers). */
  fetch?: FetchLike;
  /** Fixed port (default: a free port). */
  port?: number;
  /** Prices as decimal USDC (defaults: weather 0.01, report 2.00). */
  weatherPrice?: string;
  reportPrice?: string;
  /** Serve the proof-gated routes too. */
  proofs?: DemoSellerProofOptions;
}

export interface DemoSeller {
  url: string;
  port: number;
  weatherPaywall: Paywall;
  reportPaywall: Paywall;
  /** The proof-gated routes, when `proofs` was given. */
  proofRoutes: ProofRoutes | undefined;
  close(): Promise<void>;
}

/** Start the demo seller. The handlers return JSON once the paywall (and gate) is satisfied. */
export async function startDemoSeller(options: DemoSellerOptions): Promise<DemoSeller> {
  const network = options.network ?? "eip155:1337";
  const common = {
    facilitatorUrl: options.facilitatorUrl,
    payTo: options.payTo,
    network,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const weatherPaywall = createPaywall({
    ...common,
    price: options.weatherPrice ?? "0.01",
    description: "Current weather",
    mimeType: "application/json",
  });
  const reportPaywall = createPaywall({
    ...common,
    price: options.reportPrice ?? "2.00",
    description: "Full research report",
    mimeType: "application/json",
  });

  const weather = withPaywall(weatherPaywall, async () =>
    Response.json({ city: "San Francisco", tempC: 18, conditions: "fog" }),
  );
  const report = withPaywall(reportPaywall, async () =>
    Response.json({ title: "Q4 market report", pages: 42, summary: "Agents are the new API consumers." }),
  );

  let proofRoutes: ProofRoutes | undefined;
  if (options.proofs) {
    proofRoutes = await createProofRoutes({
      scope: options.proofs.scope,
      apiUrl: options.proofs.apiUrl,
      minAnonymitySet: options.proofs.minAnonymitySet,
      ...(options.proofs.stats ? { stats: options.proofs.stats } : {}),
      ...common,
    });
    // The nullifier is the agent's stable pseudonym at this seller: enough to rate-limit or
    // remember it, without learning which agent, account or company it is.
    const agent = (proof: VerifiedProof | undefined) => proof?.nullifier ?? null;
    proofRoutes.route("/premium", {
      require: [verifiedCompany(), canPayPerTx("0.05")],
      price: "0.05",
      body: (proof) => ({
        title: "Premium market feed",
        quotes: [{ symbol: "AGNT", price: "42.00" }],
        agent: agent(proof),
      }),
    });
    proofRoutes.route("/bid", {
      require: [reservedFor("25.00", { forSeconds: 600 })],
      body: (proof) => ({
        accepted: true,
        job: "Translate 10k product listings",
        budget: "25.00",
        agent: agent(proof),
      }),
    });
    proofRoutes.route("/jobs", {
      require: [reputation({ escrowsCompleted: 0, disputesLostAtMost: 0 })],
      body: (proof) => ({
        jobs: [
          { id: "job_label_images", pays: "12.00" },
          { id: "job_summarize_filings", pays: "30.00" },
        ],
        agent: agent(proof),
      }),
    });
  }

  const server: HttpServer = await serveWeb(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/weather") return weather(request);
    if (path === "/report") return report(request);
    return proofRoutes ? proofRoutes.handle(request) : null;
  }, options.port ?? 0);

  return {
    url: server.url,
    port: server.port,
    weatherPaywall,
    reportPaywall,
    proofRoutes,
    close: () => server.close(),
  };
}
