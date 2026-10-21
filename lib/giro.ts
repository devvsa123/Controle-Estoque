import type { RmDados } from "./rm";
import type { Dados } from "./types";

/**
 * Giro dos PIs a partir das linhas de pedido (RM) cruzado com o saldo da planilha de estoque.
 *  - classe A/B/C pelo nº de linhas de pedido no período (curva ABC de frequência: 80% / 15% / 5% das linhas);
 *  - S = tem saldo e nenhuma saída no período;
 *  - cobertura = saldo ÷ saída média diária do período (em dias).
 */
export type ClasseGiro = "A" | "B" | "C" | "S";

export interface GiroPi {
  pedidos: number; // linhas de pedido no período
  unidades: number; // unidades pedidas no período
  ultimoDia: number | null; // última saída em todo o histórico (dias desde 1970)
  saldo: number; // saldo nos paióis de estoque
  cobertura: number | null; // dias; null = sem saída
  classe: ClasseGiro;
}

export interface Giro {
  porPi: Map<string, GiroPi>;
  inicio: number;
  fim: number;
  dias: number;
}

export const NOME_CLASSE: Record<ClasseGiro, string> = {
  A: "A · alto giro (80% dos pedidos)",
  B: "B · giro médio (15% seguintes)",
  C: "C · baixo giro (5% finais)",
  S: "Sem saída no período",
};

export type FaixaCobertura = "falta" | "ok" | "alta" | "excesso" | "parado";
export const FAIXAS_COBERTURA: { id: FaixaCobertura; nome: string; ate: number }[] = [
  { id: "falta", nome: "até 30 dias (risco de falta)", ate: 30 },
  { id: "ok", nome: "30 a 180 dias (equilibrado)", ate: 180 },
  { id: "alta", nome: "180 dias a 1 ano (alto)", ate: 365 },
  { id: "excesso", nome: "mais de 1 ano (excesso)", ate: Infinity },
  { id: "parado", nome: "sem saída (parado)", ate: Infinity },
];

export function faixaCobertura(g: GiroPi): FaixaCobertura {
  if (g.cobertura === null) return "parado";
  return FAIXAS_COBERTURA.find((f) => f.id !== "parado" && g.cobertura! < f.ate)!.id;
}

/** `dias` = tamanho do período terminando na última data da planilha de pedidos; null = histórico inteiro. */
export function calcularGiro(rm: RmDados, estoque: Dados, dias: number | null): Giro {
  let min = Infinity, fim = -Infinity;
  for (const d of rm.d) { if (d < min) min = d; if (d > fim) fim = d; }
  if (!Number.isFinite(fim)) min = fim = 0;
  const inicio = dias ? Math.max(min, fim - dias + 1) : min;
  const n = fim - inicio + 1;

  const porPi = new Map<string, GiroPi>();
  const pega = (pi: string) => porPi.get(pi) ?? porPi.set(pi, { pedidos: 0, unidades: 0, ultimoDia: null, saldo: 0, cobertura: null, classe: "S" }).get(pi)!;
  for (let i = 0; i < rm.p.length; i++) {
    const g = pega(rm.pis[rm.p[i]][0]);
    const d = rm.d[i];
    if (g.ultimoDia === null || d > g.ultimoDia) g.ultimoDia = d;
    if (d < inicio || d > fim) continue;
    g.pedidos++;
    g.unidades += rm.q[i];
  }
  for (const l of estoque.linhas) {
    if (estoque.escopos[l.dep] !== "estoque") continue;
    const q = l.total || l.disp;
    if (q > 0) pega(l.pi).saldo += q;
  }

  const comSaida = [...porPi.values()].filter((g) => g.pedidos > 0).sort((a, b) => b.pedidos - a.pedidos);
  const totalLinhas = comSaida.reduce((s, g) => s + g.pedidos, 0);
  let acum = 0;
  for (const g of comSaida) {
    const antes = acum / totalLinhas;
    g.classe = antes < 0.8 ? "A" : antes < 0.95 ? "B" : "C";
    acum += g.pedidos;
  }
  for (const g of porPi.values()) g.cobertura = g.unidades > 0 ? g.saldo / (g.unidades / n) : null;
  return { porPi, inicio, fim, dias: n };
}

export const diaParaData = (d: number | null) => (d === null ? "—" : new Date(d * 86400000).toLocaleDateString("pt-BR", { timeZone: "UTC" }));
