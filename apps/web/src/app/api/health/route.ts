import { NextResponse } from "next/server";
import { dispatchApiRequest } from "../../../../../api/src/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await dispatchApiRequest({ method: "GET", path: "/health" });
  return NextResponse.json(result.body, { status: result.status });
}
