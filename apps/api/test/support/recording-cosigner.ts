import { AgentBankError, type CosignerClient } from "@agentbank/core";
import type { Address } from "viem";

/**
 * Wraps a `CosignerClient` (the real in-process co-signer from `@agentbank/cosigner`, or the
 * lightweight fake) to record calls for assertions and to simulate outages: with
 * `available = false` every call fails like an unreachable co-signer.
 */
export class RecordingCosigner implements CosignerClient {
  available = true;
  readonly calls: { method: string; input: unknown }[] = [];

  constructor(
    readonly inner: CosignerClient,
    readonly address: Address,
  ) {}

  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.input);
  }

  private async run<T>(method: string, recorded: unknown, fn: () => Promise<T>): Promise<T> {
    this.calls.push({ method, input: recorded });
    if (!this.available) throw new AgentBankError("cosigner_unavailable", "co-signer is down (test)");
    return fn();
  }

  registerSession: CosignerClient["registerSession"] = (input) =>
    this.run("registerSession", input, () => this.inner.registerSession(input));
  revokeSession: CosignerClient["revokeSession"] = (sessionId) =>
    this.run("revokeSession", { sessionId }, () => this.inner.revokeSession(sessionId));
  putPolicy: CosignerClient["putPolicy"] = (input) =>
    this.run("putPolicy", input, () => this.inner.putPolicy(input));
  getPolicy: CosignerClient["getPolicy"] = (agentId) =>
    this.run("getPolicy", { agentId }, () => this.inner.getPolicy(agentId));
  registerMandate: CosignerClient["registerMandate"] = (input) =>
    this.run("registerMandate", input, () => this.inner.registerMandate(input));
  setTreasury: CosignerClient["setTreasury"] = (input) =>
    this.run("setTreasury", input, () => this.inner.setTreasury(input));
  rotateOwner: CosignerClient["rotateOwner"] = (input) =>
    this.run("rotateOwner", input, () => this.inner.rotateOwner(input));
  registerSpendKey: CosignerClient["registerSpendKey"] = (input) =>
    this.run("registerSpendKey", input, () => this.inner.registerSpendKey(input));
  revokeMandate: CosignerClient["revokeMandate"] = (mandateId) =>
    this.run("revokeMandate", { mandateId }, () => this.inner.revokeMandate(mandateId));
  freeze: CosignerClient["freeze"] = (input) => this.run("freeze", input, () => this.inner.freeze(input));
  unfreeze: CosignerClient["unfreeze"] = (input) =>
    this.run("unfreeze", input, () => this.inner.unfreeze(input));
  evaluate: CosignerClient["evaluate"] = (input) =>
    this.run("evaluate", input, () => this.inner.evaluate(input));
  cosign: CosignerClient["cosign"] = (input) => this.run("cosign", input, () => this.inner.cosign(input));
  authorizeX402: CosignerClient["authorizeX402"] = (input) =>
    this.run("authorizeX402", input, () => this.inner.authorizeX402(input));
  reportSettlement: CosignerClient["reportSettlement"] = (input) =>
    this.run("reportSettlement", input, () => this.inner.reportSettlement(input));
  health: CosignerClient["health"] = () => this.run("health", {}, () => this.inner.health());
}
