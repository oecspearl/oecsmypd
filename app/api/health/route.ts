import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  let database: "connected" | "unreachable" = "unreachable";
  try {
    const supabase = createServiceSupabaseClient();
    const { error } = await supabase.from("users").select("id", { count: "exact", head: true });
    database = error ? "unreachable" : "connected";
  } catch {
    database = "unreachable";
  }

  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString(), database },
    { status: database === "connected" ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
