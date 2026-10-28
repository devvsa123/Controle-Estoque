export type Escopo = "estoque" | "recebimento" | "fora";

/** Uma linha da planilha = um palete/ID_QUANT em uma LOC. */
export interface Linha {
  pi: string;
  dep: string;
  area: string;
  end: string;
  disp: number; // DISPONIVEL
  total: number; // TOTAL (inclui reservado + reposição)
  forn: string;
  lote: string;
  fab: string; // yyyy-mm-dd ou ""
  val: string; // yyyy-mm-dd ou ""
  livre: boolean; // STATUS === LIVRE
  motivo: string;
  id: string;
}

export interface Produto {
  desc: string;
  familia: string; // descrição sem o tamanho/variação
  variante: string; // tamanho ou variação (ex.: "44", "GG", "CB-MR")
  cxp?: number; // caixa padrão (unidades por caixa), quando a planilha de estoque tem a coluna CXP
}

/** Posição livre que a própria planilha de estoque traz (linha com PI "VAZIO" / "POSICAO LIVRE/VAZIA"). */
export interface PosicaoVazia { dep: string; area: string; end: string }

export interface Dados {
  vazias: PosicaoVazia[]; // endereços vazios do WMS, por paiol e área
  atualizadoEm: string | null; // quando a planilha foi enviada
  fonte: "github" | "blob" | "local";
  linhas: Linha[]; // somente depósitos que entram no controle (estoque + recebimento) e fora
  produtos: Record<string, Produto>;
  escopos: Record<string, Escopo>;
}
