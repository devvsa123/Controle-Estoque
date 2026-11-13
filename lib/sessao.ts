import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

/**
 * Sessão de login: um cookie HttpOnly com o usuário, o papel e a validade, assinado com AUTH_SECRET (HMAC-SHA256).
 * Sem AUTH_SECRET (ou curto demais) ninguém entra: o sistema falha fechado.
 * Este arquivo não lê nenhum armazenamento, para o proxy.ts poder usá-lo em toda requisição.
 */

export const COOKIE_SESSAO = "ce_sessao";
export const DURACAO_SESSAO_S = 12 * 60 * 60; // 12 horas

export type Papel = "admin" | "usuario";
export interface Sessao {
  u: string; // login
  n: string; // nome
  p: Papel;
  v: number; // versão da senha: muda ao redefinir, o que derruba sessões antigas
  exp: number; // segundos desde 1970
}

export const segredoConfigurado = () => (process.env.AUTH_SECRET ?? "").length >= 32;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const assinar = (dados: string) => createHmac("sha256", process.env.AUTH_SECRET ?? "").update(dados).digest("base64url");

export function criarToken(s: Omit<Sessao, "exp">): string {
  const corpo = b64url(JSON.stringify({ ...s, exp: Math.floor(Date.now() / 1000) + DURACAO_SESSAO_S }));
  return `${corpo}.${assinar(corpo)}`;
}

/** Sessão válida (assinatura certa e dentro da validade) ou null. */
export function lerToken(token: string | undefined | null): Sessao | null {
  if (!token || !segredoConfigurado()) return null;
  const [corpo, assinatura] = token.split(".");
  if (!corpo || !assinatura) return null;
  const esperado = Buffer.from(assinar(corpo));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
  try {
    const s = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")) as Sessao;
    return typeof s.exp === "number" && s.exp > Date.now() / 1000 && s.u ? s : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ senhas */

const scrypt = promisify(scryptCb) as (senha: string, sal: Buffer, tamanho: number, opcoes: { N: number; r: number; p: number }) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, TAM = 64;

/** Hash da senha (scrypt com sal aleatório). Só ele é guardado: a senha nunca é gravada. */
export async function gerarHash(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const h = await scrypt(senha, sal, TAM, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${sal.toString("base64url")}$${h.toString("base64url")}`;
}

export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const [alg, n, r, p, sal, hash] = guardado.split("$");
  if (alg !== "scrypt" || !sal || !hash) return false;
  const esperado = Buffer.from(hash, "base64url");
  const calculado = await scrypt(senha, Buffer.from(sal, "base64url"), esperado.length, { N: +n, r: +r, p: +p });
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

/** Compara textos em tempo constante (senha do administrador de emergência). */
export function iguaisSeguro(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const opcoesCookie = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});
