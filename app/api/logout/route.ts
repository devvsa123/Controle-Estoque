import { NextResponse } from "next/server";
import { COOKIE_SESSAO, opcoesCookie } from "@/lib/sessao";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_SESSAO, "", opcoesCookie(0));
  return res;
}
