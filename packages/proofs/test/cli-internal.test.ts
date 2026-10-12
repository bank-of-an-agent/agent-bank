import { describe, expect, it, vi } from "vitest";
import { EXIT, main } from "../src/cli";

vi.mock("../src/prover", () => ({
  prove: async () => {
    throw new Error("cannot read agent_claims.zkey");
  },
}));

describe("agentbank-prove internal errors", () => {
  it("exits 1 with an internal error line", async () => {
    let err = "";
    const code = await main([], {
      readStdin: async () => JSON.stringify({ secret: "0x01", witness: {}, request: {} }),
      stdout: () => undefined,
      stderr: (text) => void (err += text),
    });
    expect(code).toBe(EXIT.internal);
    expect(JSON.parse(err)).toEqual({ error: "internal", message: "cannot read agent_claims.zkey" });
  });
});
