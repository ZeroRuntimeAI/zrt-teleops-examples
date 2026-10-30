import { readEnv, type StudioEnv } from "./env";
import { UpstreamError } from "./videosdk";

/** JSON response that no cache may keep: bodies can carry a visitor's join token. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The client address the nearest trusted proxy appended to `x-forwarded-for`: the entry `hops` from the end.
 * Entries before it come from the client and can be forged, so they are never used. "unknown" when the
 * header is missing or has fewer entries than `hops`, which means the deployment is not behind the proxies
 * `STUDIO_TRUSTED_PROXY_HOPS` says it is.
 */
export function clientIp(req: Request, hops: number): string {
  const entries = req.headers.get("x-forwarded-for")?.split(",") ?? [];
  const entry = entries.length >= hops ? entries[entries.length - hops].trim() : "";
  return entry ? entry.slice(0, 64) : "unknown";
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/**
 * Reads the environment, then runs the handler. A bad environment and any failure the handler does not
 * answer itself become a short JSON error; the detail goes to the server log, never a stack to the client.
 */
export async function withEnv(route: string, handler: (env: StudioEnv) => Promise<Response>): Promise<Response> {
  let env: StudioEnv;
  try {
    env = readEnv();
  } catch (e) {
    console.error(`[studio] ${route}: ${messageOf(e)}`);
    return json({ error: "server_misconfigured" }, 500);
  }
  try {
    return await handler(env);
  } catch (e) {
    console.error(`[studio] ${route}: ${messageOf(e)}`);
    return e instanceof UpstreamError ? json({ error: "upstream_error" }, 502) : json({ error: "internal" }, 500);
  }
}
