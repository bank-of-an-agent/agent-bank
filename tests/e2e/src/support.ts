import type { Stack } from "./stack";

/** The co-signer address this deployment commits to (from `GET /v1/meta`). */
export async function cosignerAddressOf(stack: Stack): Promise<string> {
  const res = await fetch(`${stack.apiUrl}/v1/meta`);
  const meta = (await res.json()) as { cosigner_address: string | null };
  if (!meta.cosigner_address) throw new Error("the deployment reports no co-signer address");
  return meta.cosigner_address;
}
