import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSAO, lerToken, segredoConfigurado } from "@/lib/sessao";

/**
 * Nenhuma página ou dado do sistema sem login. Aqui só se confere a assinatura e a validade do cookie (rápido);
 * as rotas de dados conferem também se o usuário continua ativo (lib/usuarios.ts, exigirSessao).
 */
const LIVRES = ["/login", "/api/login"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (LIVRES.includes(pathname)) return NextResponse.next();
  const api = pathname.startsWith("/api/");

  if (!segredoConfigurado()) {
    const msg = "Login não configurado: cadastre AUTH_SECRET (pelo menos 32 caracteres) nas variáveis de ambiente da Vercel e publique de novo.";
    return api ? NextResponse.json({ erro: msg }, { status: 503 }) : new NextResponse(msg, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (lerToken(request.cookies.get(COOKIE_SESSAO)?.value)) return NextResponse.next();

  if (api) return NextResponse.json({ erro: "Sessão expirada. Entre de novo." }, { status: 401 });
  const destino = new URL("/login", request.url);
  if (pathname !== "/") destino.searchParams.set("volta", pathname + search);
  return NextResponse.redirect(destino);
}

export const config = {
  // tudo, menos os arquivos internos do Next.js e o ícone
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
