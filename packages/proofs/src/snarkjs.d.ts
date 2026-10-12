/** The slice of snarkjs 0.7.6 this package uses (snarkjs ships no type declarations). */
declare module "snarkjs" {
  export interface SnarkjsGroth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  /** A file path (Node), a URL (browsers) or the file's bytes. */
  export type SnarkjsFile = string | Uint8Array | { type: "mem"; data: Uint8Array };

  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: SnarkjsFile,
      zkeyFile: SnarkjsFile,
      logger?: unknown,
    ): Promise<{ proof: SnarkjsGroth16Proof; publicSignals: string[] }>;
    verify(
      verificationKey: object,
      publicSignals: readonly string[],
      proof: SnarkjsGroth16Proof,
      logger?: unknown,
    ): Promise<boolean>;
    exportSolidityCallData(proof: SnarkjsGroth16Proof, publicSignals: readonly string[]): Promise<string>;
  };
}
