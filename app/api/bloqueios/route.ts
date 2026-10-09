import { jsonGzip } from "@/lib/gzip";
import { editarRegistro, listarSincronizado } from "@/lib/bloqueiosStore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return jsonGzip(await listarSincronizado());
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const { id, campos } = await req.json();
    if (typeof id !== "string" || !id || typeof campos !== "object" || campos === null) throw new Error("Pedido inválido");
    return jsonGzip({ registro: await editarRegistro(id, campos) });
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 400);
  }
}
