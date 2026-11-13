import { NextResponse } from "next/server";
import { COOKIE_SESSAO, DURACAO_SESSAO_S, criarToken, opcoesCookie, segredoConfigurado } from "@/lib/sessao";
import { autenticar } from "@/lib/usuarios";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!segredoConfigurado()) return NextResponse.json({ erro: "Login não configurado (AUTH_SECRET)." }, { status: 503 });
  try {
    const { usuario, senha } = await req.json();
    const r = await autenticar(usuario, senha);
    if ("erro" in r) {
      await new Promise((ok) => setTimeout(ok, 400)); // atrasa tentativas erradas
      return NextResponse.json({ erro: r.erro }, { status: 401 });
    }
    const res = NextResponse.json({ usuario: r.u, nome: r.n, papel: r.p });
    res.cookies.set(COOKIE_SESSAO, criarToken(r), opcoesCookie(DURACAO_SESSAO_S));
    return res;
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : "Erro ao entrar" }, { status: 500 });
  }
}
