import type { RmDados } from "./rm";
import { classificar } from "./rmAnalise";

/** Estatística de saída fracionada por PI, baseada em PEDIDOS (não em dias corridos): serve melhor a itens sazonais. */
export interface DemandaFr {
  cxp: number; // caixa padrão vigente (linha mais recente)
  frac: boolean; // já teve pedido fracionado
  n: number; // pedidos fracionados em todo o histórico
  n12: number; // pedidos fracionados nos últimos 12 meses
  primeiroDia: number;
  ultimoDia: number;
  qtdMediaPedido: number; // média da quantidade fracionada (sobra) por pedido fracionado
  intervaloMedio: number | null; // dias médios entre pedidos fracionados consecutivos (null com menos de 2 pedidos)
  mesesAtivos: number; // meses distintos com pedido fracionado
  mesesSpan: number; // meses entre o primeiro e o último pedido fracionado
  freqTexto: string; // "≈ 2 por semana", "≈ 1 por mês"...
  giro: boolean; // teve pedido fracionado nos últimos 12 meses
}

const DIAS_GIRO = 365;
const num = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const mesDoDia = (d: number) => { const t = new Date(d * 86400000); return t.getUTCFullYear() * 12 + t.getUTCMonth(); };

/** Frequência média em linguagem de operação: "≈ 2 por dia", "≈ 1 por semana", "≈ 1 por mês", "≈ 1 a cada 3 meses". */
export function textoFrequencia(n: number, primeiro: number, ultimo: number): string {
  if (n <= 0) return "—";
  if (n === 1) return "1 pedido só";
  const span = Math.max(1, ultimo - primeiro + 1);
  const porDia = n / span;
  if (porDia >= 0.95) return `≈ ${num(porDia)} por dia`;
  const porSemana = porDia * 7;
  if (porSemana >= 0.95) return `≈ ${num(porSemana)} por semana`;
  const porMes = porDia * 30.4;
  if (porMes >= 0.95) return `≈ ${num(porMes)} por mês`;
  const meses = 1 / porMes;
  return meses < 11 ? `≈ 1 a cada ${num(meses)} meses` : `≈ ${num(porDia * 365)} por ano`;
}

export function demandaFracionada(rm: RmDados | null): Map<string, DemandaFr> {
  const out = new Map<string, DemandaFr>();
  if (!rm || !rm.d.length) return out;
  let ultimoGeral = -Infinity;
  for (const d of rm.d) if (d > ultimoGeral) ultimoGeral = d;
  const dGiro = ultimoGeral - DIAS_GIRO + 1;
  const cxp = new Map<number, { dia: number; cxp: number }>();
  const acc = new Map<number, { n: number; n12: number; soma: number; primeiro: number; ultimo: number; meses: Set<number> }>();
  for (let i = 0; i < rm.p.length; i++) {
    const p = rm.p[i];
    const c = cxp.get(p);
    if (!c || rm.d[i] >= c.dia) cxp.set(p, { dia: rm.d[i], cxp: rm.c[i] });
    const cl = classificar(rm.q[i], rm.c[i]);
    if (cl.grupo === 0) continue;
    let a = acc.get(p);
    if (!a) acc.set(p, (a = { n: 0, n12: 0, soma: 0, primeiro: Infinity, ultimo: -Infinity, meses: new Set() }));
    a.n++; a.soma += cl.sobra;
    if (rm.d[i] >= dGiro) a.n12++;
    if (rm.d[i] < a.primeiro) a.primeiro = rm.d[i];
    if (rm.d[i] > a.ultimo) a.ultimo = rm.d[i];
    a.meses.add(mesDoDia(rm.d[i]));
  }
  for (const [p, c] of cxp) {
    const a = acc.get(p);
    out.set(rm.pis[p][0], a
      ? {
          cxp: c.cxp, frac: true, n: a.n, n12: a.n12, primeiroDia: a.primeiro, ultimoDia: a.ultimo,
          qtdMediaPedido: a.soma / a.n,
          intervaloMedio: a.n >= 2 ? (a.ultimo - a.primeiro) / (a.n - 1) : null,
          mesesAtivos: a.meses.size, mesesSpan: mesDoDia(a.ultimo) - mesDoDia(a.primeiro) + 1,
          freqTexto: textoFrequencia(a.n, a.primeiro, a.ultimo), giro: a.n12 > 0,
        }
      : { cxp: c.cxp, frac: false, n: 0, n12: 0, primeiroDia: 0, ultimoDia: 0, qtdMediaPedido: 0, intervaloMedio: null, mesesAtivos: 0, mesesSpan: 0, freqTexto: "—", giro: false });
  }
  return out;
}
