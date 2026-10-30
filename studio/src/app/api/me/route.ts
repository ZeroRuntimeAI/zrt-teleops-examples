import type { NextRequest } from "next/server";
import type { StudioEnv } from "../../../server/env";
import { isRecord, json, withEnv } from "../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROFILE_TIMEOUT_MS = 5000;
const MAX_NAME_LENGTH = 80;
/** Printable ASCII without spaces: safe to send as a header value (no CR/LF injection). */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** The dashboard's `user` cookie is JSON `{accessToken, uid}`; the value may or may not still be URL-encoded. */
function accessTokenFrom(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const candidates = [cookie];
  try {
    candidates.push(decodeURIComponent(cookie));
  } catch {
    // Not URL-encoded; the raw value is the only candidate.
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && typeof parsed.accessToken === "string" && HEADER_SAFE_TOKEN.test(parsed.accessToken)) {
        return parsed.accessToken;
      }
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return null;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_NAME_LENGTH) : null);

/** The signed-in display name, or null for anything but a 200 with a name. Never throws, never logs the token. */
async function profileName(env: StudioEnv, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${env.apiBase}/v1/users/profile`, {
      // The raw token, no "Bearer", as the dashboard sends it.
      headers: { Authorization: accessToken, Accept: "application/json" },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status !== 200) {
      if (res.status !== 401 && res.status !== 403) console.warn(`[studio] me: profile lookup returned ${res.status}`);
      return null;
    }
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    // The organization's `name`; the signed-in person's name is on authResponse.customer.
    const customer = isRecord(body.authResponse) && isRecord(body.authResponse.customer) ? body.authResponse.customer : {};
    return text(body.name) ?? text(customer.name);
  } catch (e) {
    console.warn(`[studio] me: profile lookup failed (${e instanceof Error ? e.name : "error"})`);
    return null;
  }
}

/** Shows the signed-in name from the shared `.zeroruntime.ai` cookie. The token is only ever sent to the API. */
export function GET(req: NextRequest): Promise<Response> {
  return withEnv("me", async (env) => {
    const accessToken = accessTokenFrom(req.cookies.get("user")?.value);
    const name = accessToken ? await profileName(env, accessToken) : null;
    return json(name ? { signedIn: true, name } : { signedIn: false });
  });
}
