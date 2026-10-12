import type { NextRequest } from "next/server";
import { memberInvite } from "@/lib/server/auth-handlers";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return memberInvite(id)(request);
}
