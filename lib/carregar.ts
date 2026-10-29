import { promises as fs } from "fs";
import path from "path";
import { get } from "@vercel/blob";
import { ARQUIVO_BLOB, ARQUIVOS_RM, ESCOPO_DEPOSITO } from "./config";
import { lerPlanilha } from "./parse";
import type { Dados } from "./types";

async function streamParaBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** O token pode ter prefixo próprio quando o store é conectado com outro nome (ex.: MEUSTORE_READ_WRITE_TOKEN). */
export function acharToken(): string | undefined {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const chave = Object.keys(process.env).find((k) => k.endsWith("_READ_WRITE_TOKEN") && process.env[k]);
  return chave ? process.env[chave] : undefined;
}

export interface ArquivoLido {
  buf: Buffer | null; // null = não mudou (etag igual ao ifNoneMatch)
  etag: string | null;
  nome: string;
  atualizadoEm: string | null;
  fonte: "github" | "blob" | "local";
}

/* ------------------------------------------------------------------ GitHub */

/**
 * Planilhas no repositório PRIVADO de armazenamento, onde o robô as publica (GITHUB_STORAGE_REPO + GITHUB_STORAGE_TOKEN,
 * token só de leitura). Ler do GitHub não gasta a cota de operações do Vercel Blob.
 */
const github = () => {
  const e = process.env;
  // aceita também GITHUB_OWNER + GITHUB_REPO / GITHUB_TOKEN, e o endereço completo do repositório
  const bruto = e.GITHUB_STORAGE_REPO || (e.GITHUB_REPO?.includes("/") ? e.GITHUB_REPO : e.GITHUB_OWNER && e.GITHUB_REPO ? `${e.GITHUB_OWNER}/${e.GITHUB_REPO}` : "");
  const repo = bruto.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const token = (e.GITHUB_STORAGE_TOKEN || e.GITHUB_TOKEN || "").trim();
  return repo && token
    ? { repo, token, branch: e.GITHUB_STORAGE_BRANCH || e.GITHUB_BRANCH || "main", api: e.GITHUB_API_URL || "https://api.github.com" }
    : null;
};

/** Pastas onde o robô pode guardar as planilhas, além da raiz (GITHUB_STORAGE_PASTAS para mudar). */
const pastas = () => (process.env.GITHUB_STORAGE_PASTAS ?? "dados_wms,dados_singra").split(",").map((p) => p.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
const caminhoUrl = (caminho: string) => caminho.split("/").map(encodeURIComponent).join("/");

async function githubApi(rota: string, accept: string, ifNoneMatch?: string | null): Promise<Response> {
  const g = github()!;
  return fetch(`${g.api}/repos/${g.repo}${rota}`, {
    headers: {
      Authorization: `Bearer ${g.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "controle-estoque",
      ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}), // resposta 304 não conta no limite de chamadas
    },
    cache: "no-store",
  });
}

const conteudo = (caminho: string, accept: string, ifNoneMatch?: string | null) =>
  githubApi(`/contents/${caminhoUrl(caminho)}?ref=${encodeURIComponent(github()!.branch)}`, accept, ifNoneMatch);

// onde cada planilha foi achada (raiz ou uma das pastas), para não procurar de novo a cada leitura
const caminhoAchado = new Map<string, string>();

/** Procura `nome` na raiz e nas pastas; devolve a resposta do primeiro caminho que existir. */
async function acharNoGithub(nome: string, accept: string, ifNoneMatch?: string | null): Promise<{ r: Response; caminho: string } | null> {
  const conhecido = caminhoAchado.get(nome);
  const candidatos = conhecido ? [conhecido, ...[nome, ...pastas().map((p) => `${p}/${nome}`)].filter((c) => c !== conhecido)] : [nome, ...pastas().map((p) => `${p}/${nome}`)];
  for (const caminho of candidatos) {
    const r = await conteudo(caminho, accept, ifNoneMatch);
    if (r.status === 404) continue;
    caminhoAchado.set(nome, caminho);
    return { r, caminho };
  }
  caminhoAchado.delete(nome);
  return null;
}

// Hora do envio: atualizado.json do robô, se existir; senão, a data do último commit que mexeu no arquivo
let cacheMeta: { etag: string; meta: Record<string, { atualizadoEm?: string }> } | null = null;
const cacheCommit = new Map<string, { etag: string; data: string | null }>();
async function horaDoEnvio(nome: string, caminho: string): Promise<string | null> {
  try {
    const r = await conteudo("atualizado.json", "application/vnd.github.raw", cacheMeta?.etag);
    if (r.ok) cacheMeta = { etag: r.headers.get("etag") ?? "", meta: await r.json() };
    else if (r.status === 404) cacheMeta = null;
    const doMeta = cacheMeta?.meta[nome]?.atualizadoEm;
    if (doMeta) return doMeta;
    const anterior = cacheCommit.get(caminho);
    const c = await githubApi(`/commits?path=${encodeURIComponent(caminho)}&sha=${encodeURIComponent(github()!.branch)}&per_page=1`, "application/vnd.github+json", anterior?.etag);
    if (c.status === 304 && anterior) return anterior.data;
    if (!c.ok) return null;
    const lista = (await c.json()) as { commit?: { committer?: { date?: string } } }[];
    const data = lista[0]?.commit?.committer?.date ?? null;
    cacheCommit.set(caminho, { etag: c.headers.get("etag") ?? "", data });
    return data;
  } catch {
    return null;
  }
}

async function lerDoGithub(nomes: string[], ifNoneMatch?: string | null): Promise<ArquivoLido> {
  const g = github()!;
  for (const nome of nomes) {
    const achado = await acharNoGithub(nome, "application/vnd.github.raw", ifNoneMatch); // conteúdo direto, até 100 MB
    if (!achado) continue;
    const { r, caminho } = achado;
    if (r.status === 304) return { buf: null, etag: ifNoneMatch ?? null, nome, atualizadoEm: await horaDoEnvio(nome, caminho), fonte: "github" };
    if (!r.ok) throw new Error(`Não consegui ler ${caminho} do repositório ${g.repo} no GitHub (resposta ${r.status}). Confira o token do GitHub na Vercel.`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, etag: r.headers.get("etag"), nome, atualizadoEm: await horaDoEnvio(nome, caminho), fonte: "github" };
  }
  throw new Error(`${nomes.map((n) => `"${n}"`).join(" ou ")} não está no repositório ${g.repo} (branch ${g.branch}, na raiz nem em ${pastas().join(", ")}). Confira se o robô já enviou a planilha.`);
}

export interface DiagnosticoPlanilha {
  arquivo: string;
  achado: boolean;
  caminho: string | null;
  bytes: number | null;
  atualizadoEm: string | null;
  erro: string | null;
}

/** Onde cada planilha está no GitHub, sem baixá-la (para conferir a configuração). */
export async function diagnosticoGithub(): Promise<{ configurado: boolean; repo: string | null; branch: string | null; pastas: string[]; planilhas: DiagnosticoPlanilha[] }> {
  const g = github();
  if (!g) return { configurado: false, repo: null, branch: null, pastas: pastas(), planilhas: [] };
  const planilhas: DiagnosticoPlanilha[] = [];
  for (const nomes of [[ARQUIVO_BLOB], ARQUIVOS_RM]) {
    let item: DiagnosticoPlanilha = { arquivo: nomes[0], achado: false, caminho: null, bytes: null, atualizadoEm: null, erro: "não encontrado" };
    for (const nome of nomes) {
      try {
        const achado = await acharNoGithub(nome, "application/vnd.github.object"); // só os dados do arquivo, sem o conteúdo
        if (!achado) continue;
        if (!achado.r.ok) { item = { ...item, arquivo: nome, caminho: achado.caminho, erro: `GitHub respondeu ${achado.r.status}` }; break; }
        const info = (await achado.r.json()) as { size?: number };
        item = { arquivo: nome, achado: true, caminho: achado.caminho, bytes: info.size ?? null, atualizadoEm: await horaDoEnvio(nome, achado.caminho), erro: null };
        break;
      } catch (e) {
        item = { ...item, erro: e instanceof Error ? e.message : String(e) };
        break;
      }
    }
    planilhas.push(item);
  }
  return { configurado: true, repo: g.repo, branch: g.branch, pastas: pastas(), planilhas };
}

/* ------------------------------------------------------------------ leitura */

/**
 * Lê o primeiro arquivo existente entre `nomes`. Com o repositório de armazenamento configurado, as planilhas vêm SÓ
 * do GitHub (o Blob fica para os JSONs); sem ele, do Vercel Blob (store privado ou público) e, sem Blob, de
 * data/<nome> para desenvolvimento local. Com `ifNoneMatch`, evita baixar de novo um arquivo que não mudou.
 */
export async function lerArquivo(nomes: string[], ifNoneMatch?: string | null): Promise<ArquivoLido> {
  if (github()) return lerDoGithub(nomes, ifNoneMatch);
  // Com o store conectado por OIDC não há token fixo: o SDK usa BLOB_STORE_ID + VERCEL_OIDC_TOKEN sozinho.
  const token = acharToken();
  if (token || process.env.BLOB_STORE_ID) {
    let ultimoErro: unknown;
    for (const nome of nomes) {
      for (const access of ["private", "public"] as const) {
        try {
          const r = await get(nome, { access, token, useCache: false, ifNoneMatch: ifNoneMatch ?? undefined });
          if (!r) continue;
          const atualizadoEm = new Date(r.blob.uploadedAt).toISOString();
          if (r.statusCode === 304) return { buf: null, etag: r.blob.etag, nome, atualizadoEm, fonte: "blob" };
          return { buf: await streamParaBuffer(r.stream), etag: r.blob.etag, nome, atualizadoEm, fonte: "blob" };
        } catch (e) {
          ultimoErro = e;
        }
      }
    }
    throw new Error(
      `Não consegui ler ${nomes.map((n) => `"${n}"`).join(" ou ")} no Vercel Blob. Confirme que o arquivo foi enviado com esse nome exato.` +
        (ultimoErro instanceof Error ? ` (${ultimoErro.message})` : "")
    );
  }
  for (const nome of nomes) {
    const local = path.join(process.cwd(), "data", nome);
    try {
      const st = await fs.stat(local);
      const etag = String(st.mtimeMs);
      if (ifNoneMatch && ifNoneMatch === etag) return { buf: null, etag, nome, atualizadoEm: st.mtime.toISOString(), fonte: "local" };
      return { buf: await fs.readFile(local), etag, nome, atualizadoEm: st.mtime.toISOString(), fonte: "local" };
    } catch {
      /* tenta o próximo nome */
    }
  }
  throw new Error(
    `Nem token nem BLOB_STORE_ID do Blob foram encontrados e não existe data/${nomes[0]}. ` +
      `Variáveis visíveis ao app que parecem do Blob: [${Object.keys(process.env).filter((k) => /BLOB|TOKEN|STORE/i.test(k)).join(", ") || "nenhuma"}]. ` +
      "Conecte o Blob store ao projeto na Vercel (Production), faça redeploy e envie a planilha com o nome esperado."
  );
}

export async function carregarDados(): Promise<Dados> {
  const { buf, atualizadoEm, fonte } = await lerArquivo([ARQUIVO_BLOB]);
  const { linhas, produtos, vazias } = lerPlanilha(buf!);
  return { atualizadoEm, fonte, linhas, produtos, vazias, escopos: ESCOPO_DEPOSITO };
}

export { ARQUIVOS_RM };
