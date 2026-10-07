import { promises as fs } from "fs";
import path from "path";
import { get } from "@vercel/blob";
import { ARQUIVO_BLOB, ESCOPO_DEPOSITO } from "./config";
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

/** Lê do Vercel Blob (store privado ou público). Sem token, cai no arquivo local de desenvolvimento. */
async function lerArquivo(): Promise<{ buf: Buffer; atualizadoEm: string | null; fonte: "blob" | "local" }> {
  // Com o store conectado por OIDC não há token fixo: o SDK usa BLOB_STORE_ID + VERCEL_OIDC_TOKEN sozinho.
  const token = acharToken();
  if (token || process.env.BLOB_STORE_ID) {
    let ultimoErro: unknown;
    for (const access of ["private", "public"] as const) {
      try {
        const r = await get(ARQUIVO_BLOB, { access, token, useCache: false });
        if (r && r.statusCode === 200) {
          return {
            buf: await streamParaBuffer(r.stream),
            atualizadoEm: new Date(r.blob.uploadedAt).toISOString(),
            fonte: "blob",
          };
        }
      } catch (e) {
        ultimoErro = e;
      }
    }
    throw new Error(
      `Não consegui ler "${ARQUIVO_BLOB}" no Vercel Blob. Confirme que o arquivo foi enviado com esse nome exato.` +
        (ultimoErro instanceof Error ? ` (${ultimoErro.message})` : "")
    );
  }
  const local = path.join(process.cwd(), "data", ARQUIVO_BLOB);
  try {
    const [buf, st] = await Promise.all([fs.readFile(local), fs.stat(local)]);
    return { buf, atualizadoEm: st.mtime.toISOString(), fonte: "local" };
  } catch {
    throw new Error(
      `Nem token nem BLOB_STORE_ID do Blob foram encontrados e não existe data/${ARQUIVO_BLOB}. ` +
        `Variáveis visíveis ao app que parecem do Blob: [${Object.keys(process.env).filter((k) => /BLOB|TOKEN|STORE/i.test(k)).join(", ") || "nenhuma"}]. ` +
        "Conecte o Blob store ao projeto na Vercel (Production), faça redeploy e envie a planilha como controle-estoque.xlsx."
    );
  }
}

export async function carregarDados(): Promise<Dados> {
  const { buf, atualizadoEm, fonte } = await lerArquivo();
  const { linhas, produtos } = lerPlanilha(buf);
  return { atualizadoEm, fonte, linhas, produtos, escopos: ESCOPO_DEPOSITO };
}
