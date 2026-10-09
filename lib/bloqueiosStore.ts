import { atualizarJson } from "./blobJson";
import { ARQUIVO_BLOB, ARQUIVO_BLOQUEIOS, MOTIVO_NAO_ENCONTRADO } from "./config";
import { lerArquivo } from "./carregar";
import { lerPlanilha } from "./parse";
import type { Armazem, CamposEditaveis, Registro, StatusTratativa } from "./bloqueios";
import { STATUS_TRATATIVA } from "./bloqueios";

const vazio = (): Armazem => ({ versao: 1, registros: {} });
const atualizar = (mutar: (a: Armazem) => boolean) => atualizarJson(ARQUIVO_BLOQUEIOS, vazio, mutar);

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
