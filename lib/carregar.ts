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
function acharToken(): string | undefined {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const chave = Object.keys(process.env).find((k) => k.endsWith("_READ_WRITE_TOKEN") && process.env[k]);
  return chave ? process.env[chave] : undefined;
}

export interface ArquivoLido {
  buf: Buffer | null; // null = não mudou (etag igual ao ifNoneMatch)
  etag: string | null;
  nome: string;
  atualizadoEm: string | null;
  fonte: "blob" | "local";
}

/**
 * Lê o primeiro arquivo existente entre `nomes` do Vercel Blob (store privado ou público).
 * Sem acesso ao Blob, cai em data/<nome> para desenvolvimento local.
 * Com `ifNoneMatch`, evita baixar de novo um arquivo que não mudou.
 */
export async function lerArquivo(nomes: string[], ifNoneMatch?: string | null): Promise<ArquivoLido> {
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
      const [buf, st] = await Promise.all([fs.readFile(local), fs.stat(local)]);
      return { buf, etag: String(st.mtimeMs), nome, atualizadoEm: st.mtime.toISOString(), fonte: "local" };
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
  const { linhas, produtos } = lerPlanilha(buf!);
  return { atualizadoEm, fonte, linhas, produtos, escopos: ESCOPO_DEPOSITO };
}

export { ARQUIVOS_RM };
