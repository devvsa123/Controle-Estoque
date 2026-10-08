import { ARQUIVOS_RM, lerArquivo } from "@/lib/carregar";
import { jsonGzip } from "@/lib/gzip";
import { lerPedidos, type RmDados } from "@/lib/rm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Cache em memória da instância: evita reprocessar ~100 mil linhas se o arquivo não mudou.
let cache: { etag: string; dados: RmDados } | null = null;

export async function GET() {
  try {
    const arq = await lerArquivo(ARQUIVOS_RM, cache?.etag);
    if (arq.buf === null && cache) return jsonGzip(cache.dados);
    const dados = lerPedidos(arq.buf!, { atualizadoEm: arq.atualizadoEm, fonte: arq.fonte, arquivo: arq.nome });
    if (arq.etag && !dados.faltando.length) cache = { etag: arq.etag, dados };
    return jsonGzip(dados);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro desconhecido";
    return jsonGzip({ erro: msg }, 500);
  }
}
