import { NextResponse } from "next/server";
import { COOKIE_SESSAO, DURACAO_SESSAO_S, criarToken, opcoesCookie } from "@/lib/sessao";
import { exigirSessao, trocarPropriaSenha } from "@/lib/usuarios";

export const dynamic = "force-dynamic";

/** Quem está logado (e se a troca de senha está pendente). */
export async function GET() {
  const s = await exigirSessao(undefined, { permitirTrocaPendente: true });
  if (s instanceof Response) return s;
  return NextResponse.json({ usuario: s.u, nome: s.n, papel: s.p, deveTrocarSenha: !!s.t });
}

/** Troca da própria senha: { atual, nova, confirmar }. */
export async function POST(req: Request) {
  const s = await exigirSessao(undefined, { permitirTrocaPendente: true });
  if (s instanceof Response) return s;
  try {
    const { atual, nova, confirmar } = await req.json();
    const nova_ = await trocarPropriaSenha(s, atual, nova, confirmar);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE_SESSAO, criarToken(nova_), opcoesCookie(DURACAO_SESSAO_S));
    return res;
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : "Erro" }, { status: 400 });
  }
}
