export type TipoMissao = "recompletamento" | "movimentacao";

/**
 * pendente      → gerada, ninguém fez ainda
 * em_execucao   → o estivador começou
 * feita         → o estivador diz que fez; aguarda a próxima planilha para confirmar
 * concluida     → a planilha de estoque confirmou o resultado
 * divergente    → a planilha não bateu com o esperado (saiu da origem e não chegou, ou foi marcada como feita e nada mudou)
 * cancelada     → perdeu o sentido ou foi cancelada
 */
export type StatusMissao = "pendente" | "em_execucao" | "feita" | "concluida" | "divergente" | "cancelada";

export const STATUS_MISSAO: { id: StatusMissao; nome: string }[] = [
  { id: "pendente", nome: "Pendente" },
  { id: "em_execucao", nome: "Em execução" },
  { id: "feita", nome: "Feita (aguarda planilha)" },
  { id: "concluida", nome: "Concluída (confirmada)" },
  { id: "divergente", nome: "Divergente" },
  { id: "cancelada", nome: "Cancelada" },
];

/** Missões que ainda precisam de ação do estoque. */
export const ABERTA = (s: StatusMissao) => s === "pendente" || s === "em_execucao" || s === "divergente";
/** Missões cujo efeito já deve ser considerado pelo planejamento (abertas ou feitas mas ainda não confirmadas). */
export const EM_ANDAMENTO = (s: StatusMissao) => ABERTA(s) || s === "feita";

export interface Local {
  dep: string;
  end: string;
}

export interface Missao {
  id: string; // R-000123 (recompletamento) ou A-000045 (ajuste do FR)
  tipo: TipoMissao;
  origem: "auto" | "manual";
  status: StatusMissao;
  prioridade: 1 | 2 | 3; // 1 = alta
  onda: 1 | 2; // 2 só depois que as de onda 1 que liberam o destino forem feitas
  pi: string;
  desc: string;
  qtd: number; // unidades
  caixas: number | null;
  de: Local;
  para: Local;
  lote: string;
  validade: string; // yyyy-mm-dd
  idQuant: string; // linha de origem no WMS (recompletamento)
  motivo: string; // regra que gerou a missão
  chave: string; // identidade estável das missões automáticas
  responsavel: string;
  obs: string;
  criadaEm: string;
  atualizadoEm: string;
  concluidaEm: string | null; // marcada como feita (ou confirmada)
  verificadaEm: string | null; // confirmada pela planilha
  motivoCancelamento: string;
  // "foto" no momento da criação, para a planilha nova provar que a missão foi feita
  baseOrigem: number;
  baseDestino: number;
  baseEm: string; // data da planilha de estoque usada
  nota: string; // observação do sistema (verificação, trocas, etc.)
  // demanda fracionada do PI no momento da criação (informativo para o estivador/gestor)
  freq?: string; // ex.: "≈ 2 por semana"
  qtdMediaPedido?: number; // média de unidades por pedido fracionado
}

export interface Parametros {
  maxCaixas: number; // máximo de caixas de um PI por LOC no fracionado
  minCaixas: number; // mínimo: abaixo disso recompleta
  maxCaixasCalcado: number;
  minCaixasCalcado: number;
  pedidosCobertura: number; // quantos pedidos fracionados "médios" o recompletamento deve cobrir
  caixasZona: number; // caixas de cada PI na zona de baixo giro (rua 01 do P02)
  pisPorLocZona: number; // quantos PIs cabem em uma LOC da zona
  caixasPorPi: Record<string, number>; // máximo de caixas por LOC específico de um PI
  locsVazias: Local[]; // LOCs FR livres, informadas manualmente (a planilha só mostra LOCs com saldo)
  locsVaziasSc: Local[]; // LOCs SC livres para devolver excedentes
}

export const PARAMS_PADRAO_MISSOES: Parametros = {
  maxCaixas: 5,
  minCaixas: 1,
  maxCaixasCalcado: 3,
  minCaixasCalcado: 1,
  pedidosCobertura: 3,
  caixasZona: 2,
  pisPorLocZona: 4,
  caixasPorPi: {},
  locsVazias: [],
  locsVaziasSc: [],
};

export interface EstadoMissoes {
  versao: 2;
  seq: { R: number; A: number };
  missoes: Record<string, Missao>;
  params: Parametros;
  /** Tabela mestre de endereçamento: PI → LOC FR "casa" (paiol|endereço). Persiste mesmo se a LOC esvaziar. */
  casas: Record<string, string>;
  /** PIs que ficaram na zona de baixo giro por falta de LOC: PI → LOC da zona. */
  zona: Record<string, string>;
}

export type NivelAlerta = "critico" | "atencao" | "info";

export interface Alerta {
  id: string;
  nivel: NivelAlerta;
  regra: string;
  titulo: string;
  detalhe: string;
  tipo?: TipoMissao;
  pi?: string;
  missaoId?: string;
  exemplos?: string[];
  total?: number;
}

export interface AvisoValidacao {
  nivel: "erro" | "aviso";
  texto: string;
}

export interface Conformidade {
  locs: number; // LOCs FR (primárias) com saldo
  conformes: number;
  maisDeUmPi: number;
  acimaDoMaximo: number;
  abaixoDoMinimo: number;
  pisSemLoc: number; // PIs com fracionado e saldo, mas sem LOC FR própria
}
