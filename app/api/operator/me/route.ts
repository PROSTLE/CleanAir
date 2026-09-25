import { NextResponse } from "next/server";
import { handleRoute, requireOperator } from "@/lib/server/http";

export const runtime = "nodejs";

/** Confirms the signed-in Firebase user is an authorised operator. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const operator = await requireOperator(request);
    return NextResponse.json({ operator });
  });
}
