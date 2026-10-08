import { carregarDados } from "@/lib/carregar";
import { jsonGzip } from "@/lib/gzip";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return jsonGzip(await carregarDados());
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro desconhecido";
    return jsonGzip({ erro: msg }, 500);
  }
}
