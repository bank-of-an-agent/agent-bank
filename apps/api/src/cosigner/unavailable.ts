import { AgentBankError, type CosignerClient } from "@agentbank/core";

const down = (): never => {
  throw new AgentBankError(
    "cosigner_unavailable",
    "No co-signer is configured (COSIGNER_URL); failing closed",
  );
};

/** Used when `COSIGNER_URL` is absent: every call fails closed, so payments are refused. */
export const unavailableCosigner: CosignerClient = {
  registerSession: async () => down(),
  revokeSession: async () => down(),
  putPolicy: async () => down(),
  getPolicy: async () => down(),
  registerMandate: async () => down(),
  setTreasury: async () => down(),
  rotateOwner: async () => down(),
  registerSpendKey: async () => down(),
  revokeMandate: async () => down(),
  freeze: async () => down(),
  unfreeze: async () => down(),
  evaluate: async () => down(),
  cosign: async () => down(),
  authorizeX402: async () => down(),
  reportSettlement: async () => down(),
  health: async () => down(),
};
