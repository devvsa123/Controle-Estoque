import { jsonGzip } from "@/lib/gzip";
import { AvisosError, alterarMissao, criarManual, salvarParametros, sincronizarEListar } from "@/lib/missoesStore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return jsonGzip(await sincronizarEListar());
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    switch (b?.acao) {
      case "alterar":
        return jsonGzip({ missao: await alterarMissao(String(b.id), b.campos ?? {}) });
      case "manual":
        return jsonGzip({ missao: await criarManual(b.missao, Boolean(b.forcar)) });
      case "params":
        return jsonGzip({ params: await salvarParametros(b.params ?? {}) });
      default:
        throw new Error("Ação inválida");
    }
  } catch (e) {
    if (e instanceof AvisosError) return jsonGzip({ erro: e.bloqueante ? "Há erros na missão" : "Confirme os avisos para criar a missão", avisos: e.avisos, bloqueante: e.bloqueante }, e.bloqueante ? 400 : 409);
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 400);
  }
}
