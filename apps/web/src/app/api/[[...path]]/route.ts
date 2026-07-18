import { after, type NextRequest, NextResponse } from "next/server";
import { dispatchApiRequest } from "../../../../../api/src/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Allow resolve/create txs to finish after the fast 200 to external pingers. */
export const maxDuration = 60;

/** Survives multi-instance Vercel: bind OTP challenge to the browser. */
const OTP_COOKIE = "probx_otp";
const OTP_COOKIE_MAX_AGE = 10 * 60; // match OTP TTL

type RouteContext = { params: Promise<{ path?: string[] }> };

function isSecureRequest(request: NextRequest): boolean {
  if (request.nextUrl.protocol === "https:") return true;
  const proto = request.headers.get("x-forwarded-proto");
  return proto === "https";
}

function cookieOptions(request: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: "lax" as const,
    path: "/",
    maxAge
  };
}

function isCronPath(apiPath: string): boolean {
  return apiPath === "/api/cron/auto-resolve" || apiPath === "/api/cron/market-cycle";
}

/**
 * Cron endpoints often run 20–50s (Arc RPC + create/resolve).
 * External pingers (cron-job.org free) time out ~30s → report Timeout even when
 * work would succeed. Auth-check sync, then finish work in `after()` so the
 * client gets 200 in <1s while Vercel keeps the isolate alive up to maxDuration.
 */
async function handleCron(request: NextRequest, apiPath: string) {
  const headers = {
    authorization: request.headers.get("authorization") ?? undefined,
    "x-session-email": request.headers.get("x-session-email") ?? undefined,
    "x-session-token": request.headers.get("x-session-token") ?? undefined
  };

  // Auth-only probe: wrong secret must still 401 before we ack.
  const expected = (process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET || "").trim();
  if (apiPath === "/api/cron/auto-resolve" && expected) {
    const q = request.nextUrl.searchParams;
    const fromQuery = q.get("secret") || q.get("cron_secret");
    const auth = (headers.authorization ?? "").trim();
    const ok = fromQuery === expected || auth === `Bearer ${expected}`;
    if (!ok) {
      return NextResponse.json(
        {
          error:
            "Cron authorization required. Set CRON_SECRET on the server and pass ?secret=… or Authorization: Bearer …"
        },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const method = request.method;
  const searchParams = request.nextUrl.searchParams;

  after(async () => {
    try {
      const result = await dispatchApiRequest({
        method,
        path: apiPath,
        searchParams,
        body: {},
        headers
      });
      if (result.status >= 400) {
        console.error(`[cron] ${apiPath} finished with ${result.status}`, result.body);
      } else {
        console.log(`[cron] ${apiPath} ok`, result.body);
      }
    } catch (error) {
      console.error(`[cron] ${apiPath} failed`, error);
    }
  });

  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      path: apiPath,
      note: "Work continues in background (up to maxDuration). External pingers should treat 200 as success."
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}

async function handle(request: NextRequest, context: RouteContext) {
  const { path: segments = [] } = await context.params;
  const joined = segments.length ? segments.join("/") : "";
  const apiPath = joined ? `/api/${joined}` : "/api";

  if (isCronPath(apiPath) && (request.method === "GET" || request.method === "POST")) {
    return handleCron(request, apiPath);
  }

  let body: Record<string, unknown> = {};
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }

  // Inject cookie-bound otpToken when the client body lost it (common on multi-instance).
  if (apiPath === "/api/wallet/session/verify-otp") {
    const fromBody = String(body.otpToken ?? "").trim();
    if (!fromBody) {
      const fromCookie = request.cookies.get(OTP_COOKIE)?.value?.trim() ?? "";
      if (fromCookie) {
        body = { ...body, otpToken: fromCookie };
      }
    }
  }

  const result = await dispatchApiRequest({
    method: request.method,
    path: apiPath,
    searchParams: request.nextUrl.searchParams,
    body,
    headers: {
      authorization: request.headers.get("authorization") ?? undefined,
      "x-session-email": request.headers.get("x-session-email") ?? undefined,
      "x-session-token": request.headers.get("x-session-token") ?? undefined
    }
  });

  const response = NextResponse.json(result.body, {
    status: result.status,
    headers: {
      "Cache-Control": "no-store"
    }
  });

  if (apiPath === "/api/wallet/session/request-otp" && result.status === 200) {
    const payload = result.body as { otpToken?: string };
    const token = String(payload?.otpToken ?? "").trim();
    if (token) {
      response.cookies.set(OTP_COOKIE, token, cookieOptions(request, OTP_COOKIE_MAX_AGE));
    }
  }

  if (apiPath === "/api/wallet/session/verify-otp" && result.status >= 200 && result.status < 300) {
    response.cookies.set(OTP_COOKIE, "", cookieOptions(request, 0));
  }

  return response;
}

export async function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization, x-session-email, x-session-token"
    }
  });
}
