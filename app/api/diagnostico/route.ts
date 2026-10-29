import { diagnosticoGithub } from "@/lib/carregar";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Abra /api/diagnostico no navegador para ver de qual repositório e pasta do GitHub cada planilha está vindo. */
export async function GET() {
  try {
    return Response.json(await diagnosticoGithub(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, { status: 500 });
  }
}
