import { promises as fs } from "fs";
import path from "path";
import { get, put } from "@vercel/blob";
import { acharToken } from "./carregar";

type Acesso = "public" | "private";
let acessoOk: Acesso | null = null; // descobre uma vez se o store é público ou privado

const usaBlob = () => Boolean(acharToken() || process.env.BLOB_STORE_ID);

class Conflito extends Error {}

/** Lê um JSON do Blob (ou de data/<nome> sem Blob). Devolve `vazio()` se ainda não existir. */
export async function lerJson<T>(nome: string, vazio: () => T): Promise<{ dados: T; etag: string | null }> {
  if (!usaBlob()) {
    try {
      return { dados: JSON.parse(await fs.readFile(path.join(process.cwd(), "data", nome), "utf8")), etag: null };
    } catch {
      return { dados: vazio(), etag: null };
    }
  }
  const token = acharToken();
  for (const access of acessoOk ? [acessoOk] : (["public", "private"] as Acesso[])) {
    try {
      const r = await get(nome, { access, token, useCache: false });
      if (!r || r.statusCode !== 200) continue; // ainda não existe
      acessoOk = access;
      return { dados: JSON.parse(await new Response(r.stream).text()) as T, etag: r.blob.etag };
    } catch {
      /* tenta o outro tipo de acesso */
    }
  }
  return { dados: vazio(), etag: null };
}

async function gravarJson<T>(nome: string, dados: T, etag: string | null): Promise<void> {
  const corpo = JSON.stringify(dados);
  if (!usaBlob()) {
    await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), "data", nome), corpo);
    return;
  }
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
      if (e instanceof Error && /precondition|etag|412|match/i.test(e.message)) throw new Conflito(e.message);
    }
  }
  throw ultimoErro instanceof Error ? ultimoErro : new Error(`Falha ao gravar ${nome}`);
}

/** Lê, aplica `mutar` e grava; refaz se outra pessoa gravou no meio (ifMatch). `mutar` devolve false se nada mudou. */
export async function atualizarJson<T>(nome: string, vazio: () => T, mutar: (d: T) => boolean): Promise<T> {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const { dados, etag } = await lerJson(nome, vazio);
    if (!mutar(dados)) return dados;
    try {
      await gravarJson(nome, dados, etag);
      return dados;
    } catch (e) {
      if (!(e instanceof Conflito)) throw e;
    }
  }
  throw new Error("Outra pessoa estava gravando ao mesmo tempo. Tente de novo.");
}
