import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getSnapshot();
  return NextResponse.json(snapshot, {
    headers: { "cache-control": "no-store" },
  });
}
