import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { acharToken, caminhoUrl, github, githubApi } from "./carregar";

/**
 * JSONs compartilhados do sistema (missões, tratativas de bloqueio, classificação de grupos).
 *  - Com o GitHub configurado: no mesmo repositório privado das planilhas, na pasta GITHUB_PASTA_ESTADO
 *    (padrão dados_controle/). O token precisa de Contents: Read and write.
 *  - Sem GitHub: Vercel Blob; sem Blob: data/<nome> (desenvolvimento local).
 * Ler só devolve o estado vazio quando o arquivo NÃO EXISTE. Qualquer outra falha interrompe, para nunca
 * gravar um estado vazio por cima dos dados de verdade.
 */

type Acesso = "public" | "private";
let acessoOk: Acesso | null = null; // descobre uma vez se o store é público ou privado

const usaBlob = () => Boolean(acharToken() || process.env.BLOB_STORE_ID);

class Conflito extends Error {}

/** O armazenamento respondeu com erro (não é "arquivo ainda não existe"). */
export class ArmazenamentoIndisponivel extends Error {}

/* ------------------------------------------------------------------ GitHub */

const pastaEstado = () => (process.env.GITHUB_PASTA_ESTADO ?? "dados_controle").trim().replace(/^\/+|\/+$/g, "");
const caminhoGithub = (nome: string) => (pastaEstado() ? `${pastaEstado()}/${nome}` : nome);
/** Identificador que o GitHub dá ao conteúdo do arquivo: é ele que a gravação exige para não sobrescrever outra versão. */
const shaGit = (buf: Buffer) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

async function lerGithub<T>(nome: string, vazio: () => T): Promise<{ dados: T; etag: string | null }> {
  const g = github()!;
  const caminho = caminhoGithub(nome);
  const r = await githubApi(`/contents/${caminhoUrl(caminho)}?ref=${encodeURIComponent(g.branch)}`, "application/vnd.github.raw");
  if (r.status === 404) {
    // primeira vez no GitHub: traz o que houver no Blob (migração); se o Blob não responder, começa do zero
    const doBlob = usaBlob() ? await lerBlob(nome, () => null as T | null).catch(() => null) : null;
    return { dados: doBlob?.dados ?? vazio(), etag: null };
  }
  if (!r.ok) throw new ArmazenamentoIndisponivel(`Não consegui ler ${caminho} do repositório ${g.repo} no GitHub (resposta ${r.status}). Confira o GITHUB_TOKEN na Vercel.`);
  const buf = Buffer.from(await r.arrayBuffer());
  try {
    return { dados: JSON.parse(buf.toString("utf8")) as T, etag: shaGit(buf) };
  } catch {
    throw new ArmazenamentoIndisponivel(`${caminho} no GitHub não é um JSON válido. Corrija ou apague o arquivo no repositório ${g.repo}.`);
  }
}

async function gravarGithub<T>(nome: string, dados: T, etag: string | null): Promise<void> {
  const g = github()!;
  const caminho = caminhoGithub(nome);
  const r = await githubApi(`/contents/${caminhoUrl(caminho)}`, "application/vnd.github+json", null, {
    method: "PUT",
    body: {
      message: `Controle de Estoque: ${nome}`,
      content: Buffer.from(JSON.stringify(dados), "utf8").toString("base64"),
      branch: g.branch,
      ...(etag ? { sha: etag } : {}),
    },
  });
  if (r.ok) return;
  // 409: o arquivo mudou desde a leitura; 422: alguém criou o arquivo no meio (falta o sha) -> lê de novo e refaz
  if (r.status === 409 || r.status === 422) throw new Conflito(`GitHub ${r.status}`);
  if (r.status === 403 || r.status === 404) {
    throw new ArmazenamentoIndisponivel(`O token do GitHub não pode gravar em ${g.repo} (resposta ${r.status}). Ele precisa de Contents: Read and write nesse repositório.`);
  }
  throw new ArmazenamentoIndisponivel(`Não consegui gravar ${caminho} no GitHub (resposta ${r.status}).`);
}

/* ------------------------------------------------------------------ Vercel Blob */

async function lerBlob<T>(nome: string, vazio: () => T): Promise<{ dados: T; etag: string | null }> {
  const token = acharToken();
  let naoExiste = false;
  let ultimoErro: unknown = null;
  for (const access of acessoOk ? [acessoOk] : (["public", "private"] as Acesso[])) {
    try {
      const r = await get(nome, { access, token, useCache: false });
      if (!r) { naoExiste = true; continue; } // 404: ainda não existe
      if (r.statusCode !== 200) { ultimoErro = new Error(`resposta ${r.statusCode}`); continue; }
      acessoOk = access;
      return { dados: JSON.parse(await new Response(r.stream).text()) as T, etag: r.blob.etag };
    } catch (e) {
      ultimoErro = e; // tenta o outro tipo de acesso
    }
  }
  if (naoExiste) return { dados: vazio(), etag: null };
  throw new ArmazenamentoIndisponivel(`O Vercel Blob não respondeu ao ler ${nome}${ultimoErro instanceof Error ? ` (${ultimoErro.message})` : ""}.`);
}

async function gravarBlob<T>(nome: string, dados: T, etag: string | null): Promise<void> {
  const corpo = JSON.stringify(dados);
  const token = acharToken();
  let ultimoErro: unknown;
  for (const access of acessoOk ? [acessoOk] : (["public", "private"] as Acesso[])) {
    try {
      await put(nome, corpo, {
        access, token, contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
        ...(etag ? { ifMatch: etag } : {}),
      });
      acessoOk = access;
      return;
    } catch (e) {
      ultimoErro = e;
      if (e instanceof BlobPreconditionFailedError || (e instanceof Error && /precondition|etag|412/i.test(e.message))) throw new Conflito(e.message);
    }
  }
  throw ultimoErro instanceof Error ? ultimoErro : new Error(`Falha ao gravar ${nome}`);
}

/* ------------------------------------------------------------------ arquivo local */

const arquivoLocal = (nome: string) => path.join(process.cwd(), "data", nome);

async function lerLocal<T>(nome: string, vazio: () => T): Promise<{ dados: T; etag: string | null }> {
  let texto: string;
  try {
    texto = await fs.readFile(arquivoLocal(nome), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { dados: vazio(), etag: null };
    throw e;
  }
  return { dados: JSON.parse(texto) as T, etag: null };
}

/* ------------------------------------------------------------------ interface */

/** Lê um JSON. Devolve `vazio()` só se o arquivo ainda não existir; outras falhas viram ArmazenamentoIndisponivel. */
export async function lerJson<T>(nome: string, vazio: () => T): Promise<{ dados: T; etag: string | null }> {
  if (github()) return lerGithub(nome, vazio);
  if (usaBlob()) return lerBlob(nome, vazio);
  return lerLocal(nome, vazio);
}

/**
 * Lê, aplica `mutar` e grava com controle de concorrência: se outra pessoa gravou no meio, lê de novo e refaz.
 * No Blob, o MESMO etag falhando de novo não é concorrência (a condição não é aceita): grava sem a condição.
 * `mutar` devolve false se nada mudou.
 */
export async function atualizarJson<T>(nome: string, vazio: () => T, mutar: (d: T) => boolean): Promise<T> {
  if (!github() && !usaBlob()) {
    const { dados } = await lerLocal(nome, vazio);
    if (!mutar(dados)) return dados;
    await fs.mkdir(path.dirname(arquivoLocal(nome)), { recursive: true });
    await fs.writeFile(arquivoLocal(nome), JSON.stringify(dados));
    return dados;
  }
  const noGithub = Boolean(github());
  let etagQueFalhou: string | null = null;
  let ultimoErro = "";
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { dados, etag } = await lerJson(nome, vazio);
    if (!mutar(dados)) return dados;
    try {
      if (noGithub) await gravarGithub(nome, dados, etag);
      else await gravarBlob(nome, dados, etag !== null && etag === etagQueFalhou ? null : etag);
      return dados;
    } catch (e) {
      if (!(e instanceof Conflito)) throw e;
      etagQueFalhou = etag;
      ultimoErro = e.message;
    }
  }
  throw new Error(`Não consegui gravar ${nome} (conflito de escrita repetido). Detalhe técnico: ${ultimoErro}`);
}
