export type StatusTratativa = "pendente" | "em_busca" | "localizado" | "ajuste" | "resolvido";

export const STATUS_TRATATIVA: { id: StatusTratativa; nome: string }[] = [
  { id: "pendente", nome: "Pendente" },
  { id: "em_busca", nome: "Em busca" },
  { id: "localizado", nome: "Localizado (falta ajustar)" },
  { id: "ajuste", nome: "Ajuste de estoque solicitado" },
  { id: "resolvido", nome: "Resolvido" },
];

/** Uma linha bloqueada como NAO ENCONTRADO, identificada pelo ID_QUANT. */
export interface Registro {
  id: string;
  pi: string;
  desc: string;
  dep: string;
  area: string;
  end: string;
  qtd: number;
  lote: string;
  primeiroVisto: string; // ISO: quando entrou neste controle
  ultimoVisto: string; // ISO: última sincronização em que ainda estava na planilha
  saiuEm: string | null; // ISO: quando deixou de aparecer como NAO ENCONTRADO na planilha
  status: StatusTratativa;
  responsavel: string;
  obs: string;
  atualizadoEm: string | null; // última edição manual
}

export interface Armazem {
  versao: 1;
  registros: Record<string, Registro>;
}

export interface CamposEditaveis {
  status: StatusTratativa;
  responsavel: string;
  obs: string;
}
