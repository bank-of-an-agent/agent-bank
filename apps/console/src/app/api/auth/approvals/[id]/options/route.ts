import type { NextRequest } from "next/server";
import { approvalOptions } from "@/lib/server/auth-handlers";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return approvalOptions(id)(request);
}
