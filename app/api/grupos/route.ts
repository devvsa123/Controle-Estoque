import { exigirSessao } from "@/lib/usuarios";
import { jsonGzip } from "@/lib/gzip";
import { lerClassificacao, salvarClassificacao } from "@/lib/gruposStore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const sessao = await exigirSessao();
  if (sessao instanceof Response) return sessao;
  try {
    return jsonGzip(await lerClassificacao());
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 500);
  }
}

export async function POST(req: Request) {
  const sessao = await exigirSessao();
  if (sessao instanceof Response) return sessao;
  try {
    const b = await req.json();
    if (typeof b !== "object" || b === null) throw new Error("Pedido inválido");
    return jsonGzip(await salvarClassificacao(b.familias ?? {}, b.cores ?? {}));
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 400);
  }
}
