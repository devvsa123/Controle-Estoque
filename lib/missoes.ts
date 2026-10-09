export type TipoMissao = "recompletamento" | "movimentacao";
export type StatusMissao = "pendente" | "em_execucao" | "concluida" | "cancelada";

export const STATUS_MISSAO: { id: StatusMissao; nome: string }[] = [
  { id: "pendente", nome: "Pendente" },
  { id: "em_execucao", nome: "Em execução" },
  { id: "concluida", nome: "Concluída" },
  { id: "cancelada", nome: "Cancelada" },
];

export const ABERTA = (s: StatusMissao) => s === "pendente" || s === "em_execucao";

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
  pi: string;
  desc: string;
  qtd: number; // unidades
  caixas: number | null; // recompletamento: nº de caixas fechadas
  de: Local;
  para: Local;
  lote: string; // do estoque de origem (informativo)
  validade: string; // yyyy-mm-dd (informativo)
  idQuant: string; // linha de origem no WMS (recompletamento)
  motivo: string; // por que a missão existe (a regra que a gerou)
  chave: string; // idempotência das missões automáticas
  responsavel: string;
  obs: string;
  criadaEm: string;
  atualizadoEm: string;
  concluidaEm: string | null;
  motivoCancelamento: string;
}

export interface Parametros {
  diasAlvo: number; // cobertura desejada no FR após recompletar
  caixasLoc: number; // caixas que cabem em uma LOC FR
  minCaixasFr: number; // abaixo disso o PI precisa de recompletamento
  janela: number; // dias da média de saída
  caixasPorPi: Record<string, number>;
  locsVazias: Local[]; // LOCs FR livres, informadas manualmente (a planilha só mostra LOCs com saldo)
  limiteRecomp: number; // máximo de missões automáticas de recompletamento abertas
  limiteMov: number; // máximo de missões automáticas de movimentação abertas
}

export const PARAMS_PADRAO_MISSOES: Parametros = {
  diasAlvo: 7,
  caixasLoc: 15,
  minCaixasFr: 1,
  janela: 90,
  caixasPorPi: {},
  locsVazias: [],
  limiteRecomp: 100,
  limiteMov: 30,
};

export interface EstadoMissoes {
  versao: 1;
  seq: { R: number; A: number };
  missoes: Record<string, Missao>;
  params: Parametros;
}

export type NivelAlerta = "critico" | "atencao" | "info";

export interface Alerta {
  id: string;
  nivel: NivelAlerta;
  regra: string; // regra que foi quebrada
  titulo: string;
  detalhe: string;
  tipo?: TipoMissao; // aba onde o alerta é relevante
  pi?: string;
  missaoId?: string;
  exemplos?: string[];
  total?: number;
}

export interface AvisoValidacao {
  nivel: "erro" | "aviso";
  texto: string;
}
