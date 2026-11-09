import { exigirSessao } from "@/lib/usuarios";
import { jsonGzip } from "@/lib/gzip";
import { obterEstoque } from "@/lib/fontes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const sessao = await exigirSessao();
  if (sessao instanceof Response) return sessao;
  try {
    return jsonGzip(await obterEstoque());
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 500);
  }
}
