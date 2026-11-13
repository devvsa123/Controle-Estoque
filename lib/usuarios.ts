import { cookies } from "next/headers";
import { atualizarJson, lerJson } from "./blobJson";
import { COOKIE_SESSAO, conferirSenha, gerarHash, iguaisSeguro, lerToken, type Papel, type Sessao } from "./sessao";

/**
 * Usuários do sistema, no mesmo modelo do Sistema de Tramitação de NF:
 *  - login pelo NIP (só números); senha com no mínimo 8 caracteres, guardada só como hash;
 *  - primeiro acesso: tela de Configuração inicial cria o administrador enquanto não houver nenhum usuário;
 *  - senha inicial definida pelo administrador, com troca obrigatória no primeiro acesso;
 *  - 5 senhas erradas bloqueiam o usuário por 15 minutos.
 * Fica em controle-usuarios.json (pasta dados_controle/ do repositório privado, como os outros JSONs).
 * Opcional: ADMIN_USUARIO + ADMIN_SENHA na Vercel criam um administrador de emergência, que não aparece na lista.
 */

export const ARQUIVO_USUARIOS = "controle-usuarios.json";
const MAX_FALHAS = 5;
const MINUTOS_BLOQUEIO = 15;

export interface Usuario {
  nome: string;
  hash: string;
  papel: Papel;
  ativo: boolean;
  v: number; // muda a cada troca de senha / desativação: derruba as sessões abertas
  deveTrocarSenha?: boolean;
  falhas?: number;
  bloqueadoAte?: string | null;
  criadoEm: string;
  criadoPor: string;
  ultimoAcesso: string | null;
}
interface Armazem { versao: 1; usuarios: Record<string, Usuario> }
const vazio = (): Armazem => ({ versao: 1, usuarios: {} });

export const SENHA_MIN = 8;
/** NIP: só os números (aceita digitado com ponto ou traço). Outros logins (ex.: o de emergência) ficam em minúsculas. */
export const normLogin = (s: unknown) => {
  const t = String(s ?? "").trim();
  return /^[\d.\-\/\s]+$/.test(t) ? t.replace(/\D/g, "") : t.toLowerCase();
};
const RE_NIP = /^\d{3,20}$/;

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

export function validarSenhaNova(senha: unknown, confirmar: unknown): string | null {
  const s = String(senha ?? "");
  if (s.length < SENHA_MIN) return `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`;
  if (s.length > 200) return "Senha longa demais.";
  if (s !== String(confirmar ?? "")) return "As senhas não coincidem.";
  return null;
}

export async function existeAlgumUsuario(): Promise<boolean> {
  return Object.keys((await ler(true)).usuarios).length > 0;
}

const sessaoDe = (login: string, u: Usuario): Omit<Sessao, "exp"> => ({ u: login, n: u.nome, p: u.papel, v: u.v, ...(u.deveTrocarSenha ? { t: true } : {}) });

/* ------------------------------------------------------------------ login */

const HASH_FALSO = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);
// para quem não está no cadastro (não há onde gravar as falhas): freio por instância do servidor
const falhasSemCadastro = new Map<string, { n: number; ate: number }>();

export async function autenticar(loginBruto: unknown, senha: unknown): Promise<Omit<Sessao, "exp"> | { erro: string }> {
  const login = normLogin(loginBruto);
  const s = String(senha ?? "");
  const invalido = { erro: "Usuário ou senha inválidos." };
  const muitas = { erro: `Muitas tentativas. Aguarde ${MINUTOS_BLOQUEIO} minutos e tente novamente.` };
  if (!login || !s) return invalido;

  const adm = adminEmergencia();
  const u = (await ler(true)).usuarios[login];
  if (!u) {
    const f = falhasSemCadastro.get(login);
    if (f && f.n >= MAX_FALHAS && f.ate > Date.now()) return muitas;
    if (adm && login === adm.u && iguaisSeguro(s, adm.s)) { falhasSemCadastro.delete(login); return { u: login, n: "Administrador", p: "admin", v: 0 }; }
    await conferirSenha(s, HASH_FALSO); // tempo de resposta igual ao de um usuário existente
    falhasSemCadastro.set(login, { n: f && f.ate > Date.now() ? f.n + 1 : 1, ate: Date.now() + MINUTOS_BLOQUEIO * 60_000 });
    return invalido;
  }
  if (u.bloqueadoAte && new Date(u.bloqueadoAte) > new Date()) return muitas;
  if (!u.ativo || !(await conferirSenha(s, u.hash))) {
    await atualizar((a) => {
      const x = a.usuarios[login];
      if (!x) return false;
      x.falhas = (x.falhas ?? 0) + 1;
      if (x.falhas >= MAX_FALHAS) x.bloqueadoAte = new Date(Date.now() + MINUTOS_BLOQUEIO * 60_000).toISOString();
      return true;
    }).catch(() => undefined);
    return invalido;
  }
  const atualizado = await atualizar((a) => {
    const x = a.usuarios[login];
    if (!x) return false;
    x.falhas = 0; x.bloqueadoAte = null; x.ultimoAcesso = new Date().toISOString();
    return true;
  }).catch(() => null);
  return sessaoDe(login, atualizado?.usuarios[login] ?? u);
}

/** Configuração inicial: cria o primeiro administrador. Só funciona enquanto não existir nenhum usuário. */
export async function criarPrimeiroAdmin(nome: unknown, loginBruto: unknown, senha: unknown, confirmar: unknown): Promise<Omit<Sessao, "exp">> {
  const login = normLogin(loginBruto);
  const n = String(nome ?? "").trim().slice(0, 80);
  if (!n || !RE_NIP.test(login)) throw new Error("Informe nome e usuário (NIP, somente números).");
  const erro = validarSenhaNova(senha, confirmar);
  if (erro) throw new Error(erro);
  const hash = await gerarHash(String(senha));
  let criado = false;
  await atualizar((a) => {
    if (Object.keys(a.usuarios).length) return false; // a trava de concorrência do armazenamento impede dois "primeiros"
    a.usuarios[login] = { nome: n, hash, papel: "admin", ativo: true, v: 1, criadoEm: new Date().toISOString(), criadoPor: "configuração inicial", ultimoAcesso: new Date().toISOString() };
    criado = true;
    return true;
  });
  if (!criado) throw new Error("O sistema já foi configurado. Use a tela de login.");
  return sessaoDe(login, (await ler(true)).usuarios[login]);
}

/** Sessão da requisição atual, conferida contra o cadastro (usuário apagado, desativado ou com senha redefinida perde o acesso). */
export async function sessaoAtual(): Promise<Sessao | null> {
  const s = lerToken((await cookies()).get(COOKIE_SESSAO)?.value);
  if (!s) return null;
  const adm = adminEmergencia();
  const u = (await ler()).usuarios[s.u];
  if (!u) return adm && s.u === adm.u && s.p === "admin" ? s : null;
  if (!u.ativo || u.v !== s.v) return null;
  return { ...s, n: u.nome, p: u.papel, t: !!u.deveTrocarSenha };
}

const naoAutorizado = (msg: string, status: number) => Response.json({ erro: msg }, { status });

/** Para as rotas de dados: devolve a sessão ou a resposta 401/403 pronta. */
export async function exigirSessao(papel?: Papel, opcoes: { permitirTrocaPendente?: boolean } = {}): Promise<Sessao | Response> {
  let s: Sessao | null;
  try {
    s = await sessaoAtual();
  } catch (e) {
    return naoAutorizado(`Não consegui conferir o login: ${e instanceof Error ? e.message : "erro desconhecido"}`, 503);
  }
  if (!s) return naoAutorizado("Sessão expirada. Entre de novo.", 401);
  if (s.t && !opcoes.permitirTrocaPendente) return naoAutorizado("Troque a senha antes de continuar.", 403);
  if (papel === "admin" && s.p !== "admin") return naoAutorizado("Só o administrador pode fazer isso.", 403);
  return s;
}

/** O próprio usuário troca a senha (exige a atual). Devolve a sessão nova, já que a troca derruba as outras. */
export async function trocarPropriaSenha(quem: Sessao, atual: unknown, nova: unknown, confirmar: unknown): Promise<Omit<Sessao, "exp">> {
  const erro = validarSenhaNova(nova, confirmar);
  if (erro) throw new Error(erro);
  const u = (await ler(true)).usuarios[quem.u];
  if (!u) throw new Error("A senha do administrador de emergência é trocada na Vercel (ADMIN_SENHA).");
  if (!(await conferirSenha(String(atual ?? ""), u.hash))) throw new Error("Senha atual incorreta.");
  if (String(atual) === String(nova)) throw new Error("A nova senha deve ser diferente da atual.");
  const hash = await gerarHash(String(nova));
  const dados = await atualizar((a) => { const x = a.usuarios[quem.u]; if (!x) return false; x.hash = hash; x.v++; x.deveTrocarSenha = false; return true; });
  return sessaoDe(quem.u, dados.usuarios[quem.u]);
}

/* ------------------------------------------------------------------ cadastro (admin) */

export interface UsuarioPublico {
  login: string; nome: string; papel: Papel; ativo: boolean; deveTrocarSenha: boolean; bloqueado: boolean;
  criadoEm: string; criadoPor: string; ultimoAcesso: string | null;
}

export async function listarUsuarios(): Promise<UsuarioPublico[]> {
  const a = await ler(true);
  return Object.entries(a.usuarios)
    .map(([login, u]) => ({
      login, nome: u.nome, papel: u.papel, ativo: u.ativo, deveTrocarSenha: !!u.deveTrocarSenha,
      bloqueado: !!u.bloqueadoAte && new Date(u.bloqueadoAte) > new Date(),
      criadoEm: u.criadoEm, criadoPor: u.criadoPor, ultimoAcesso: u.ultimoAcesso,
    }))
    .sort((x, y) => x.nome.localeCompare(y.nome, "pt-BR"));
}

export async function gerenciarUsuario(acao: string, dados: Record<string, unknown>, quem: Sessao): Promise<void> {
  const login = normLogin(dados.login);
  if (acao === "criar" && !RE_NIP.test(login)) throw new Error("Informe o NIP (somente números).");
  if (adminEmergencia()?.u === login) throw new Error("Esse usuário é o administrador de emergência (configurado na Vercel).");
  const papel: Papel = dados.papel === "admin" ? "admin" : "usuario";
  const deveTrocar = dados.deveTrocar !== false; // padrão: obriga a trocar no primeiro acesso
  let hash = "";
  if (acao === "criar" || acao === "senha") {
    const erro = validarSenhaNova(dados.senha, dados.senha);
    if (erro) throw new Error(erro);
    hash = await gerarHash(String(dados.senha));
  }
  let erro = "";
  await atualizar((a) => {
    const u = a.usuarios[login];
    if (acao === "criar") {
      if (u) { erro = "Já existe um usuário com esse NIP."; return false; }
      const nome = String(dados.nome ?? "").trim().slice(0, 80);
      if (!nome) { erro = "Informe o nome."; return false; }
      a.usuarios[login] = { nome, hash, papel, ativo: true, v: 1, deveTrocarSenha: deveTrocar, criadoEm: new Date().toISOString(), criadoPor: quem.n || quem.u, ultimoAcesso: null };
      return true;
    }
    if (!u) { erro = "Usuário não encontrado."; return false; }
    if (login === quem.u && acao !== "senha") { erro = "Você não pode alterar o próprio acesso por aqui."; return false; }
    switch (acao) {
      case "senha": u.hash = hash; u.v++; u.deveTrocarSenha = deveTrocar; u.falhas = 0; u.bloqueadoAte = null; return true;
      case "desbloquear": u.falhas = 0; u.bloqueadoAte = null; return true;
      case "ativar": u.ativo = true; return true;
      case "desativar": u.ativo = false; u.v++; return true;
      case "papel": u.papel = papel; u.v++; return true;
      case "remover": delete a.usuarios[login]; return true;
      default: erro = "Ação inválida."; return false;
    }
  });
  if (erro) throw new Error(erro);
}
