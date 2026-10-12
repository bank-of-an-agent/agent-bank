import type { NextRequest } from "next/server";
import { handleApiProxy } from "@/lib/server/api-proxy";

interface Context {
  params: Promise<{ path: string[] }>;
}

async function proxy(request: NextRequest, context: Context): Promise<Response> {
  const { path } = await context.params;
  return handleApiProxy(request, ["v1", ...path]);
}

export { proxy as DELETE, proxy as GET, proxy as POST, proxy as PUT };
