import { promises as fs } from "fs";
import path from "path";
import { get } from "@vercel/blob";
import { ARQUIVO_BLOB, ESCOPO_DEPOSITO } from "./config";
import { lerPlanilha } from "./parse";
import type { Dados } from "./types";

async function streamParaBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** Lê do Vercel Blob (store privado ou público). Sem token, cai no arquivo local de desenvolvimento. */
async function lerArquivo(): Promise<{ buf: Buffer; atualizadoEm: string | null; fonte: "blob" | "local" }> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    let ultimoErro: unknown;
    for (const access of ["private", "public"] as const) {
      try {
        const r = await get(ARQUIVO_BLOB, { access, useCache: false });
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
      `BLOB_READ_WRITE_TOKEN não configurado e não existe data/${ARQUIVO_BLOB}. ` +
        "Conecte o Blob store ao projeto na Vercel e envie a planilha como controle-estoque.xlsx."
    );
  }
}

export async function carregarDados(): Promise<Dados> {
  const { buf, atualizadoEm, fonte } = await lerArquivo();
  const { linhas, produtos } = lerPlanilha(buf);
  return { atualizadoEm, fonte, linhas, produtos, escopos: ESCOPO_DEPOSITO };
}
