import { jsonGzip } from "@/lib/gzip";
import { obterRm } from "@/lib/fontes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const { rm, erro } = await obterRm();
  if (rm) return jsonGzip(rm);
  return jsonGzip({ erro: erro ?? "Planilha de pedidos indisponível" }, 500);
}
