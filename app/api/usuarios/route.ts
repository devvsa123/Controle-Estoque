import { jsonGzip } from "@/lib/gzip";
import { exigirSessao, gerenciarUsuario, listarUsuarios } from "@/lib/usuarios";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const s = await exigirSessao("admin");
  if (s instanceof Response) return s;
  try {
    return jsonGzip({ usuarios: await listarUsuarios() });
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 500);
  }
}

/** { acao: "criar" | "senha" | "ativar" | "desativar" | "papel" | "remover", login, nome?, senha?, papel? } */
export async function POST(req: Request) {
  const s = await exigirSessao("admin");
  if (s instanceof Response) return s;
  try {
    const b = await req.json();
    await gerenciarUsuario(String(b?.acao ?? ""), b ?? {}, s);
    return jsonGzip({ usuarios: await listarUsuarios() });
  } catch (e) {
    return jsonGzip({ erro: e instanceof Error ? e.message : "Erro desconhecido" }, 400);
  }
}
