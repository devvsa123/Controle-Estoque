import { DEPOSITOS_FORA_VAZIOS, ESCOPO_DEPOSITO } from "./config";
import type { Local } from "./missoes";
import type { Dados } from "./types";

export interface Vazios {
  fr: Local[];
  sc: Local[];
  arquivo: string | null;
  atualizadoEm: string | null;
  erro: string | null;
}

/**
 * LOCs vazias que a planilha de estoque traz (linhas com PI "VAZIO"). Só paióis de estoque (P01, P02, P05); P03, P33, REC, P04, P07 e P06 ficam de fora.
 * Servem de coringa para as movimentações maiores dentro de cada paiol (devolver caixas ao SC, casa nova de um PI).
 */
export function vaziosDoEstoque(dados: Dados): Vazios {
  const fr: Local[] = [], sc: Local[] = [];
  for (const v of dados.vazias ?? []) {
    if (DEPOSITOS_FORA_VAZIOS.includes(v.dep) || ESCOPO_DEPOSITO[v.dep] !== "estoque") continue;
    if (v.area === "FR") fr.push({ dep: v.dep, end: v.end });
    else if (v.area === "SC") sc.push({ dep: v.dep, end: v.end });
  }
  return {
    fr, sc, arquivo: "planilha de estoque", atualizadoEm: dados.atualizadoEm,
    erro: fr.length + sc.length === 0 ? "A planilha de estoque não trouxe linhas de posição vazia (PI \"VAZIO\"). As missões usam só as LOCs vazias informadas nos parâmetros." : null,
  };
}
