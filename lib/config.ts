import type { Escopo } from "./types";

/**
 * Regras de negócio dos depósitos.
 *  - estoque: conta como estoque real
 *  - recebimento: ainda não pode ser contado para fornecimento, medido à parte
 *  - fora: não faz parte do controle (mantido só para consulta)
 */
export const ESCOPO_DEPOSITO: Record<string, Escopo> = {
  P01: "estoque",
  P02: "estoque",
  P03: "estoque",
  P04: "estoque",
  P05: "estoque",
  P06: "estoque",
  P07: "recebimento",
  REC: "recebimento",
  AQB: "fora",
  CLI: "fora",
  EST: "fora",
  EXP: "fora",
  INV: "fora",
  P08: "fora",
  P33: "fora",
};

export const NOME_DEPOSITO: Record<string, string> = {
  P01: "Paiol 01 · calçados",
  P02: "Paiol 02 · maior paiol",
  P03: "Paiol 03 · volante (temporário)",
  P04: "Paiol 04 · AVEP, itens pequenos de alto valor",
  P05: "Paiol 05 · fardamento de maior valor",
  P06: "Paiol 06 · tecidos e peças prontas",
  P07: "Paiol 07 · recebimento",
  REC: "Recebimento",
  AQB: "AQB · ajuste de estoque",
  CLI: "CLI · LOC virtual (não encontrados)",
  EST: "EST · fluxo de saída / bugs sistêmicos",
  EXP: "EXP · expedição",
  INV: "INV · inventário",
  P08: "Paiol 08 · material destinado",
  P33: "P33 · desconsiderar",
};

export const NOME_AREA: Record<string, string> = {
  FR: "Fracionado (picking)",
  SC: "Caixa fechada",
};

export const ARQUIVO_BLOB = "controle-estoque.xlsx";

/** Planilha de pedidos (RM). O robô publica como .xls, mas o conteúdo é XLSX. */
export const ARQUIVOS_RM = ["planilha_estoque.xls", "planilha_estoque.xlsx", "planilha_estoque"];

/** PIs com saldo nestes depósitos ficam fora da reposição do FR (o P04 tem gestão própria). */
export const DEPOSITOS_FORA_REPOSICAO = ["P04"];

/** Controle de tratativa dos bloqueios "NAO ENCONTRADO" (JSON compartilhado, gravado no Blob). */
export const ARQUIVO_BLOQUEIOS = "controle-bloqueios-nao-encontrado.json";
export const MOTIVO_NAO_ENCONTRADO = "NAO ENCONTRADO";
