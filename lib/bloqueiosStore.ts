import { promises as fs } from "fs";
import path from "path";
import { get, put } from "@vercel/blob";
import { ARQUIVO_BLOB, ARQUIVO_BLOQUEIOS, MOTIVO_NAO_ENCONTRADO } from "./config";
import { acharToken, lerArquivo } from "./carregar";
import { lerPlanilha } from "./parse";
import type { Armazem, CamposEditaveis, Registro, StatusTratativa } from "./bloqueios";
import { STATUS_TRATATIVA } from "./bloqueios";

type Acesso = "public" | "private";
let acessoOk: Acesso | null = null; // descobre uma vez se o store é público ou privado

const usaBlob = () => Boolean(acharToken() || process.env.BLOB_STORE_ID);
const vazio = (): Armazem => ({ versao: 1, registros: {} });

/* ----------------------------------------------------------------- leitura/gravação */

async function lerStore(): Promise<{ dados: Armazem; etag: string | null }> {
  if (!usaBlob()) {
    try {
      const txt = await fs.readFile(path.join(process.cwd(), "data", ARQUIVO_BLOQUEIOS), "utf8");
      return { dados: JSON.parse(txt), etag: null };
    } catch {
      return { dados: vazio(), etag: null };
    }
  }
  const token = acharToken();
  for (const access of acessoOk ? [acessoOk] : (["public", "private"] as Acesso[])) {
    try {
      const r = await get(ARQUIVO_BLOQUEIOS, { access, token, useCache: false });
      if (!r) continue; // ainda não existe
      if (r.statusCode !== 200) continue;
      acessoOk = access;
      const dados = JSON.parse(await new Response(r.stream).text()) as Armazem;
      return { dados, etag: r.blob.etag };
    } catch {
      /* tenta o outro tipo de acesso */
    }
  }
  return { dados: vazio(), etag: null };
}

class Conflito extends Error {}

async function gravarStore(dados: Armazem, etag: string | null): Promise<void> {
  const corpo = JSON.stringify(dados);
  if (!usaBlob()) {
    await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), "data", ARQUIVO_BLOQUEIOS), corpo);
    return;
  }
  const token = acharToken();
  let ultimoErro: unknown;
  for (const access of acessoOk ? [acessoOk] : (["public", "private"] as Acesso[])) {
    try {
      await put(ARQUIVO_BLOQUEIOS, corpo, {
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
  throw ultimoErro instanceof Error ? ultimoErro : new Error("Falha ao gravar o controle de bloqueios");
}

/** Lê, aplica `mutar` e grava; refaz se outra pessoa gravou no meio (ifMatch). `mutar` devolve false se nada mudou. */
async function atualizar(mutar: (a: Armazem) => boolean): Promise<Armazem> {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const { dados, etag } = await lerStore();
    if (!mutar(dados)) return dados;
    try {
      await gravarStore(dados, etag);
      return dados;
    } catch (e) {
      if (!(e instanceof Conflito)) throw e;
    }
  }
  throw new Error("Outra pessoa estava gravando ao mesmo tempo. Tente de novo.");
}

/* ---------------------------------------------------------- bloqueios na planilha */

type ItemNE = Pick<Registro, "id" | "pi" | "desc" | "dep" | "area" | "end" | "qtd" | "lote">;
let cacheNE: { etag: string; itens: ItemNE[]; atualizadoEm: string | null } | null = null;

async function itensNaoEncontrado(): Promise<{ itens: ItemNE[]; atualizadoEm: string | null }> {
  const arq = await lerArquivo([ARQUIVO_BLOB], cacheNE?.etag);
  if (arq.buf === null && cacheNE) return cacheNE;
  const { linhas, produtos } = lerPlanilha(arq.buf!);
  const itens: ItemNE[] = linhas
    .filter((l) => !l.livre && l.motivo.toUpperCase().trim() === MOTIVO_NAO_ENCONTRADO && l.id)
    .map((l) => ({ id: l.id, pi: l.pi, desc: produtos[l.pi]?.desc ?? "", dep: l.dep, area: l.area, end: l.end, qtd: l.disp, lote: l.lote }));
  const r = { etag: arq.etag ?? "", itens, atualizadoEm: arq.atualizadoEm };
  if (arq.etag) cacheNE = r;
  return r;
}

/** Sincroniza o controle com a planilha: cria registros novos e marca os que deixaram de aparecer. */
export async function listarSincronizado(): Promise<{ registros: Registro[]; planilhaEm: string | null }> {
  const { itens, atualizadoEm } = await itensNaoEncontrado();
  const agora = new Date().toISOString();
  const atuais = new Map(itens.map((i) => [i.id, i]));
  // Proteção: se a planilha veio sem nenhum NAO ENCONTRADO, mas o controle tem itens ativos, não dá baixa em massa
  // (pode ser arquivo incompleto). Eles só são marcados como "saiu" quando a lista atual não está vazia.
  const dados = await atualizar((a) => {
    let mudou = false;
    for (const it of itens) {
      const r = a.registros[it.id];
      if (!r) {
        a.registros[it.id] = { ...it, primeiroVisto: agora, ultimoVisto: agora, saiuEm: null, status: "pendente", responsavel: "", obs: "", atualizadoEm: null };
        mudou = true;
      } else {
        const novo = { ...r, ...it, ultimoVisto: agora, saiuEm: null };
        // evita regravar a cada acesso: só persiste se algo relevante mudou
        if (r.saiuEm || r.pi !== it.pi || r.dep !== it.dep || r.end !== it.end || r.qtd !== it.qtd || r.lote !== it.lote || r.desc !== it.desc) {
          a.registros[it.id] = novo;
          mudou = true;
        }
      }
    }
    if (itens.length > 0) {
      for (const r of Object.values(a.registros)) {
        if (!atuais.has(r.id) && !r.saiuEm) {
          r.saiuEm = agora;
          mudou = true;
        }
      }
    }
    return mudou;
  });
  return { registros: Object.values(dados.registros), planilhaEm: atualizadoEm };
}

export async function editarRegistro(id: string, campos: Partial<CamposEditaveis>): Promise<Registro> {
  const ids = STATUS_TRATATIVA.map((s) => s.id);
  if (campos.status !== undefined && !ids.includes(campos.status as StatusTratativa)) throw new Error("Status inválido");
  let editado: Registro | null = null;
  await atualizar((a) => {
    const r = a.registros[id];
    if (!r) return false;
    if (campos.status !== undefined) r.status = campos.status;
    if (campos.responsavel !== undefined) r.responsavel = String(campos.responsavel).slice(0, 80);
    if (campos.obs !== undefined) r.obs = String(campos.obs).slice(0, 600);
    r.atualizadoEm = new Date().toISOString();
    editado = r;
    return true;
  });
  if (!editado) throw new Error("Registro não encontrado. Recarregue a página.");
  return editado;
}
