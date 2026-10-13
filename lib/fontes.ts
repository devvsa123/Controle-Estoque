import { ARQUIVOS_RM, ARQUIVOS_VAZIOS, ESCOPO_DEPOSITO, ARQUIVO_BLOB } from "./config";
import { lerArquivo } from "./carregar";
import { lerPlanilha } from "./parse";
import { lerPedidos, type RmDados } from "./rm";
import type { Dados } from "./types";
import { lerVazios, SEM_VAZIOS, type Vazios } from "./vazios";

// Cache em memória da instância, validado pelo etag do arquivo: não reprocessa se a planilha não mudou.
let cacheEstoque: { etag: string; dados: Dados } | null = null;
let cacheRm: { etag: string; dados: RmDados } | null = null;
let cacheVazios: { etag: string; dados: Vazios } | null = null;

export async function obterEstoque(): Promise<Dados> {
  const arq = await lerArquivo([ARQUIVO_BLOB], cacheEstoque?.etag);
  if (arq.buf === null && cacheEstoque) return cacheEstoque.dados;
  const { linhas, produtos } = lerPlanilha(arq.buf!);
  const dados: Dados = { atualizadoEm: arq.atualizadoEm, fonte: arq.fonte, linhas, produtos, escopos: ESCOPO_DEPOSITO };
  if (arq.etag) cacheEstoque = { etag: arq.etag, dados };
  return dados;
}

/** Planilha de pedidos. Devolve null se não existir ou não tiver QTD/CXP (as missões automáticas dependem dela). */
export async function obterRm(): Promise<{ rm: RmDados | null; erro: string | null }> {
  try {
    const arq = await lerArquivo(ARQUIVOS_RM, cacheRm?.etag);
    if (arq.buf === null && cacheRm) return { rm: cacheRm.dados, erro: null };
    const dados = lerPedidos(arq.buf!, { atualizadoEm: arq.atualizadoEm, fonte: arq.fonte, arquivo: arq.nome });
    if (dados.faltando.length) return { rm: null, erro: `A planilha de pedidos não tem as colunas ${dados.faltando.join(", ")}` };
    if (arq.etag) cacheRm = { etag: arq.etag, dados };
    return { rm: dados, erro: null };
  } catch (e) {
    return { rm: null, erro: e instanceof Error ? e.message : "Falha ao ler a planilha de pedidos" };
  }
}

/** Endereços vazios (consulta do WMS). Arquivo ausente não é erro fatal: as missões só não usam LOCs vazias da planilha. */
export async function obterVazios(): Promise<Vazios> {
  try {
    const arq = await lerArquivo(ARQUIVOS_VAZIOS, cacheVazios?.etag);
    if (arq.buf === null && cacheVazios) return cacheVazios.dados;
    const dados: Vazios = { ...lerVazios(arq.buf!), arquivo: arq.nome, atualizadoEm: arq.atualizadoEm, erro: null };
    if (arq.etag) cacheVazios = { etag: arq.etag, dados };
    return dados;
  } catch {
    return { ...SEM_VAZIOS, erro: `Arquivo de endereços vazios não encontrado (envie ao Blob como "${ARQUIVOS_VAZIOS[0]}"). As missões usam só as LOCs vazias informadas nos parâmetros.` };
  }
}
