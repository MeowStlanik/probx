import { type NextRequest, NextResponse } from "next/server";
import { dispatchApiRequest } from "../../../../../api/src/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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

async function handle(request: NextRequest, context: RouteContext) {
  const { path: segments = [] } = await context.params;
  const joined = segments.length ? segments.join("/") : "";
  const apiPath = joined ? `/api/${joined}` : "/api";

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
