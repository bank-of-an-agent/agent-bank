import "server-only";
import { cookies } from "next/headers";
import { cookieNames, secureCookies } from "./cookies";
import { readPrincipalSession, readStaffSession, type PrincipalSession, type StaffSession } from "./session";

/** The signed-in principal for server components (route handlers read `request.cookies`). */
export async function currentPrincipal(): Promise<PrincipalSession | null> {
  const store = await cookies();
  return readPrincipalSession(store.get(cookieNames(secureCookies()).session)?.value);
}

export async function currentStaff(): Promise<StaffSession | null> {
  const store = await cookies();
  return readStaffSession(store.get(cookieNames(secureCookies()).staff)?.value);
}
