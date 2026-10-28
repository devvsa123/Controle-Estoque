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
  const repo = process.env.GITHUB_STORAGE_REPO, token = process.env.GITHUB_STORAGE_TOKEN;
  return repo && token
    ? { repo, token, branch: process.env.GITHUB_STORAGE_BRANCH || "main", api: process.env.GITHUB_API_URL || "https://api.github.com" }
    : null;
};

async function githubConteudo(nome: string, ifNoneMatch?: string | null): Promise<Response> {
  const g = github()!;
  return fetch(`${g.api}/repos/${g.repo}/contents/${encodeURIComponent(nome)}?ref=${encodeURIComponent(g.branch)}`, {
    headers: {
      Authorization: `Bearer ${g.token}`,
      Accept: "application/vnd.github.raw", // conteúdo direto (aceita arquivos de até 100 MB)
      "X-GitHub-Api-Version": "2022-11-28",
      ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}), // resposta 304 não conta no limite de chamadas
    },
    cache: "no-store",
  });
}

// atualizado.json: hora em que o robô enviou cada planilha
let cacheMeta: { etag: string; meta: Record<string, { atualizadoEm?: string }> } | null = null;
async function horaDoEnvio(nome: string): Promise<string | null> {
  try {
    const r = await githubConteudo("atualizado.json", cacheMeta?.etag);
    if (r.ok) cacheMeta = { etag: r.headers.get("etag") ?? "", meta: await r.json() };
    return cacheMeta?.meta[nome]?.atualizadoEm ?? null;
  } catch {
    return null;
  }
}

/** null = GitHub não configurado ou sem nenhum dos arquivos (aí segue para o Blob). */
async function lerDoGithub(nomes: string[], ifNoneMatch?: string | null): Promise<ArquivoLido | null> {
  if (!github()) return null;
  for (const nome of nomes) {
    try {
      const r = await githubConteudo(nome, ifNoneMatch);
      if (r.status === 404) continue;
      if (r.status === 304) return { buf: null, etag: ifNoneMatch ?? null, nome, atualizadoEm: await horaDoEnvio(nome), fonte: "github" };
      if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      return { buf, etag: r.headers.get("etag"), nome, atualizadoEm: await horaDoEnvio(nome), fonte: "github" };
    } catch (e) {
      console.error(`Falha ao ler ${nome} do GitHub; tentando o Blob.`, e);
      return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ leitura */

/**
 * Lê o primeiro arquivo existente entre `nomes`: primeiro do repositório de armazenamento no GitHub (se configurado),
 * depois do Vercel Blob (store privado ou público). Sem nenhum dos dois, cai em data/<nome> para desenvolvimento local.
 * Com `ifNoneMatch`, evita baixar de novo um arquivo que não mudou.
 */
export async function lerArquivo(nomes: string[], ifNoneMatch?: string | null): Promise<ArquivoLido> {
  const doGithub = await lerDoGithub(nomes, ifNoneMatch);
  if (doGithub) return doGithub;
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
