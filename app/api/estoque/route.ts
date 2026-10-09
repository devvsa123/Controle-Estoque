import { jsonGzip } from "@/lib/gzip";
import { obterEstoque } from "@/lib/fontes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return jsonGzip(await obterEstoque());
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 500);
  }
}
