import { NextResponse } from "next/server";
import { COOKIE_SESSAO, DURACAO_SESSAO_S, criarToken, opcoesCookie, segredoConfigurado } from "@/lib/sessao";
import { criarPrimeiroAdmin, existeAlgumUsuario } from "@/lib/usuarios";

export const dynamic = "force-dynamic";

/** { configurado }: se já existe algum usuário (a tela de login manda para a configuração inicial quando não). */
export async function GET() {
  try {
    return NextResponse.json({ configurado: await existeAlgumUsuario() });
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : "Erro" }, { status: 503 });
  }
}

/** Configuração inicial: { nome, login, senha, confirmar }. Só funciona enquanto não existir nenhum usuário. */
export async function POST(req: Request) {
  if (!segredoConfigurado()) return NextResponse.json({ erro: "Login não configurado (AUTH_SECRET)." }, { status: 503 });
  try {
    const { nome, login, senha, confirmar } = await req.json();
    const s = await criarPrimeiroAdmin(nome, login, senha, confirmar);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE_SESSAO, criarToken(s), opcoesCookie(DURACAO_SESSAO_S));
    return res;
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : "Erro" }, { status: 400 });
  }
}
