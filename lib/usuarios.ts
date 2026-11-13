import { cookies } from "next/headers";
import { atualizarJson, lerJson } from "./blobJson";
import { COOKIE_SESSAO, conferirSenha, gerarHash, iguaisSeguro, lerToken, type Papel, type Sessao } from "./sessao";

/**
 * Usuários do sistema, em controle-usuarios.json (mesmo lugar dos outros JSONs: pasta dados_controle/ do repositório
 * privado). Guarda só o hash da senha.
 * Administrador de emergência: ADMIN_USUARIO + ADMIN_SENHA nas variáveis da Vercel. Serve para o primeiro acesso e
 * para nunca ficar trancado do lado de fora; ele não aparece na lista e não pode ser apagado pelo sistema.
 */

export const ARQUIVO_USUARIOS = "controle-usuarios.json";

export interface Usuario {
  nome: string;
  hash: string;
  papel: Papel;
  ativo: boolean;
  v: number; // muda a cada troca de senha / desativação: derruba as sessões abertas
  criadoEm: string;
  criadoPor: string;
  ultimoAcesso: string | null;
}
interface Armazem { versao: 1; usuarios: Record<string, Usuario> }
const vazio = (): Armazem => ({ versao: 1, usuarios: {} });

export const RE_LOGIN = /^[a-z0-9._-]{3,40}$/;
export const SENHA_MIN = 8;
export const normLogin = (s: unknown) => String(s ?? "").trim().toLowerCase();

const adminEmergencia = () => {
  const u = normLogin(process.env.ADMIN_USUARIO), s = process.env.ADMIN_SENHA ?? "";
  return u && s.length >= SENHA_MIN ? { u, s } : null;
};

// cache curto: cada chamada de dados confere se o usuário continua ativo sem ir ao GitHub toda vez
let cache: { em: number; dados: Armazem } | null = null;
async function ler(fresco = false): Promise<Armazem> {
  if (!fresco && cache && Date.now() - cache.em < 30_000) return cache.dados;
  const { dados } = await lerJson(ARQUIVO_USUARIOS, vazio);
  cache = { em: Date.now(), dados };
  return dados;
}
async function atualizar(mutar: (a: Armazem) => boolean): Promise<Armazem> {
  const dados = await atualizarJson(ARQUIVO_USUARIOS, vazio, mutar);
  cache = { em: Date.now(), dados };
  return dados;
}

/* ------------------------------------------------------------------ login */

// Freio contra tentativa e erro: 5 senhas erradas para o mesmo login bloqueiam por 15 minutos (por instância do servidor).
const falhas = new Map<string, { n: number; ate: number }>();
const bloqueado = (login: string) => { const f = falhas.get(login); return !!f && f.n >= 5 && f.ate > Date.now(); };
const registrarFalha = (login: string) => {
  const f = falhas.get(login);
  const n = f && f.ate > Date.now() ? f.n + 1 : 1;
  falhas.set(login, { n, ate: Date.now() + 15 * 60_000 });
};

export async function autenticar(loginBruto: unknown, senha: unknown): Promise<Omit<Sessao, "exp"> | { erro: string }> {
  const login = normLogin(loginBruto);
  const s = String(senha ?? "");
  if (!login || !s) return { erro: "Informe usuário e senha." };
  if (bloqueado(login)) return { erro: "Muitas tentativas erradas. Espere 15 minutos e tente de novo." };

  const adm = adminEmergencia();
  if (adm && login === adm.u) {
    if (iguaisSeguro(s, adm.s)) { falhas.delete(login); return { u: login, n: "Administrador", p: "admin", v: 0 }; }
    registrarFalha(login);
    return { erro: "Usuário ou senha incorretos." };
  }

  const u = (await ler(true)).usuarios[login];
  // confere a senha mesmo sem usuário, para a resposta levar o mesmo tempo nos dois casos
  const ok = await conferirSenha(s, u?.hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86));
  if (!u || !ok || !u.ativo) {
    registrarFalha(login);
    return { erro: u && ok && !u.ativo ? "Este usuário está desativado. Fale com o administrador." : "Usuário ou senha incorretos." };
  }
  falhas.delete(login);
  await atualizar((a) => { const x = a.usuarios[login]; if (!x) return false; x.ultimoAcesso = new Date().toISOString(); return true; }).catch(() => undefined);
  return { u: login, n: u.nome, p: u.papel, v: u.v };
}

/** Sessão da requisição atual, conferida contra o cadastro (usuário apagado, desativado ou com senha redefinida perde o acesso). */
export async function sessaoAtual(): Promise<Sessao | null> {
  const s = lerToken((await cookies()).get(COOKIE_SESSAO)?.value);
  if (!s) return null;
  const adm = adminEmergencia();
  if (adm && s.u === adm.u) return s.p === "admin" ? s : null;
  const u = (await ler()).usuarios[s.u];
  if (!u || !u.ativo || u.v !== s.v) return null;
  return { ...s, n: u.nome, p: u.papel };
}

const naoAutorizado = (msg: string, status: number) => Response.json({ erro: msg }, { status });

/** Para as rotas de dados: devolve a sessão ou a resposta 401/403 pronta. */
export async function exigirSessao(papel?: Papel): Promise<Sessao | Response> {
  let s: Sessao | null;
  try {
    s = await sessaoAtual();
  } catch (e) {
    return naoAutorizado(`Não consegui conferir o login: ${e instanceof Error ? e.message : "erro desconhecido"}`, 503);
  }
  if (!s) return naoAutorizado("Sessão expirada. Entre de novo.", 401);
  if (papel === "admin" && s.p !== "admin") return naoAutorizado("Só o administrador pode fazer isso.", 403);
  return s;
}

/* ------------------------------------------------------------------ cadastro (admin) */

export interface UsuarioPublico { login: string; nome: string; papel: Papel; ativo: boolean; criadoEm: string; criadoPor: string; ultimoAcesso: string | null }

export async function listarUsuarios(): Promise<UsuarioPublico[]> {
  const a = await ler(true);
  return Object.entries(a.usuarios)
    .map(([login, u]) => ({ login, nome: u.nome, papel: u.papel, ativo: u.ativo, criadoEm: u.criadoEm, criadoPor: u.criadoPor, ultimoAcesso: u.ultimoAcesso }))
    .sort((x, y) => x.nome.localeCompare(y.nome, "pt-BR"));
}

const validarSenha = (s: unknown) => {
  const senha = String(s ?? "");
  if (senha.length < SENHA_MIN) throw new Error(`A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`);
  if (senha.length > 200) throw new Error("Senha longa demais.");
  return senha;
};

export async function gerenciarUsuario(acao: string, dados: Record<string, unknown>, quem: Sessao): Promise<void> {
  const login = normLogin(dados.login);
  if (!RE_LOGIN.test(login)) throw new Error("Usuário inválido: use de 3 a 40 letras minúsculas, números, ponto, hífen ou sublinhado.");
  if (adminEmergencia()?.u === login) throw new Error("Esse nome é do administrador de emergência (configurado na Vercel).");
  const papel: Papel = dados.papel === "admin" ? "admin" : "usuario";
  const hash = acao === "criar" || acao === "senha" ? await gerarHash(validarSenha(dados.senha)) : "";
  let erro = "";
  await atualizar((a) => {
    const u = a.usuarios[login];
    if (acao === "criar") {
      if (u) { erro = "Já existe um usuário com esse nome."; return false; }
      const nome = String(dados.nome ?? "").trim().slice(0, 80);
      if (!nome) { erro = "Informe o nome."; return false; }
      a.usuarios[login] = { nome, hash, papel, ativo: true, v: 1, criadoEm: new Date().toISOString(), criadoPor: quem.u, ultimoAcesso: null };
      return true;
    }
    if (!u) { erro = "Usuário não encontrado."; return false; }
    if (login === quem.u && acao !== "senha") { erro = "Você não pode alterar o próprio acesso por aqui."; return false; }
    switch (acao) {
      case "senha": u.hash = hash; u.v++; return true;
      case "ativar": u.ativo = true; return true;
      case "desativar": u.ativo = false; u.v++; return true;
      case "papel": u.papel = papel; u.v++; return true;
      case "remover": delete a.usuarios[login]; return true;
      default: erro = "Ação inválida."; return false;
    }
  });
  if (erro) throw new Error(erro);
}

/** O próprio usuário troca a senha (exige a atual). Devolve a sessão nova, já que a troca derruba as outras. */
export async function trocarPropriaSenha(quem: Sessao, atual: unknown, nova: unknown): Promise<Omit<Sessao, "exp">> {
  if (adminEmergencia()?.u === quem.u) throw new Error("A senha do administrador de emergência é trocada na Vercel (ADMIN_SENHA).");
  const novaSenha = validarSenha(nova);
  const u = (await ler(true)).usuarios[quem.u];
  if (!u || !(await conferirSenha(String(atual ?? ""), u.hash))) throw new Error("A senha atual não confere.");
  const hash = await gerarHash(novaSenha);
  let v = 0;
  await atualizar((a) => { const x = a.usuarios[quem.u]; if (!x) return false; x.hash = hash; x.v++; v = x.v; return true; });
  return { u: quem.u, n: u.nome, p: u.papel, v };
}
