import { ARQUIVO_BLOB } from "@/lib/config";
import { lerArquivo } from "@/lib/carregar";
import { exigirSessao } from "@/lib/usuarios";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A planilha controle-estoque.xlsx inteira, como o robô enviou (só para quem está logado). */
export async function GET() {
  const sessao = await exigirSessao();
  if (sessao instanceof Response) return sessao;
  try {
    const arq = await lerArquivo([ARQUIVO_BLOB]);
    const data = (arq.atualizadoEm ?? new Date().toISOString()).slice(0, 10);
    return new Response(new Uint8Array(arq.buf!), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="controle-estoque-${data}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(`Não consegui baixar a planilha: ${e instanceof Error ? e.message : "erro desconhecido"}`, { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
