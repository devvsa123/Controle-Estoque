import { NextResponse } from "next/server";
import { carregarDados } from "@/lib/carregar";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const dados = await carregarDados();
    return NextResponse.json(dados, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro desconhecido";
    return NextResponse.json({ erro: msg }, { status: 500 });
  }
}
