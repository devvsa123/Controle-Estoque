import type { RmDados } from "./rm";
import type { Dados } from "./types";

/** Faixas da sobra fracionada em relação à caixa padrão. */
export const LIM_PEQUENA = 0.1; // sobra <= 10%  -> grupo 2
export const LIM_QUASE = 0.85; // sobra  > 85%  -> grupo 1

export type Grupo = 0 | 1 | 2 | 3; // 0 = caixa fechada (múltiplo exato)

export const NOME_GRUPO: Record<Grupo, string> = {
  0: "Caixa fechada",
  1: "G1 · Quase uma caixa (sobra acima de 85%)",
  2: "G2 · Sobra pequena (até 10% da caixa)",
  3: "G3 · Sobra intermediária (10% a 85%)",
};

const EPS = 1e-6;

export interface Classe {
  grupo: Grupo;
  sobra: number; // unidades que sobram depois das caixas fechadas
  caixas: number; // caixas fechadas completas dentro do pedido
}

/** Pedido múltiplo da caixa = caixa fechada. Senão é fracionado e o grupo vem da SOBRA (qtd mod cxp). */
export function classificar(qtd: number, cxp: number): Classe {
  const caixas = Math.floor(qtd / cxp + EPS);
  let sobra = qtd - caixas * cxp;
  if (Math.abs(sobra) < EPS || Math.abs(sobra - cxp) < EPS) {
    return { grupo: 0, sobra: 0, caixas: Math.round(qtd / cxp) };
  }
  sobra = Math.round(sobra * 1e6) / 1e6;
  const r = sobra / cxp;
  const grupo: Grupo = r <= LIM_PEQUENA ? 2 : r > LIM_QUASE ? 1 : 3;
  return { grupo, sobra, caixas };
}

export interface Filtro {
  dMin: number; // dia mínimo (inclusive)
  dMax: number;
}

export interface VisaoGeral {
  linhas: number;
  fechadas: number;
  fracionadas: number;
  rms: number;
  rmsComFracionado: number;
  porGrupo: Record<1 | 2 | 3, { n: number; unidadesSobra: number; unidadesPedido: number }>;
  porMes: { mes: string; linhas: number; fracionadas: number }[];
  topPis: Record<0 | 1 | 2 | 3, { pi: string; desc: string; n: number; unidades: number }[]>; // 0 = todos os fracionados
  primeiroDia: number;
  ultimoDia: number;
}

export function mesDe(dia: number): string {
  const d = new Date(dia * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function visaoGeral(rm: RmDados, f: Filtro): VisaoGeral {
  const v: VisaoGeral = {
    linhas: 0, fechadas: 0, fracionadas: 0, rms: 0, rmsComFracionado: 0,
    porGrupo: { 1: { n: 0, unidadesSobra: 0, unidadesPedido: 0 }, 2: { n: 0, unidadesSobra: 0, unidadesPedido: 0 }, 3: { n: 0, unidadesSobra: 0, unidadesPedido: 0 } },
    porMes: [], topPis: { 0: [], 1: [], 2: [], 3: [] }, primeiroDia: Infinity, ultimoDia: -Infinity,
  };
  const meses = new Map<string, { linhas: number; fracionadas: number }>();
  const rmsVistas = new Set<number>();
  const rmsFr = new Set<number>();
  const pis: Record<number, Map<number, { n: number; unidades: number }>> = { 0: new Map(), 1: new Map(), 2: new Map(), 3: new Map() };

  for (let i = 0; i < rm.p.length; i++) {
    const d = rm.d[i];
    if (d < f.dMin || d > f.dMax) continue;
    const cl = classificar(rm.q[i], rm.c[i]);
    v.linhas++;
    rmsVistas.add(rm.r[i]);
    if (d < v.primeiroDia) v.primeiroDia = d;
    if (d > v.ultimoDia) v.ultimoDia = d;
    const m = mesDe(d);
    let mm = meses.get(m);
    if (!mm) meses.set(m, (mm = { linhas: 0, fracionadas: 0 }));
    mm.linhas++;
    if (cl.grupo === 0) { v.fechadas++; continue; }
    v.fracionadas++;
    mm.fracionadas++;
    rmsFr.add(rm.r[i]);
    const g = v.porGrupo[cl.grupo as 1 | 2 | 3];
    g.n++; g.unidadesSobra += cl.sobra; g.unidadesPedido += rm.q[i];
    for (const k of [0, cl.grupo] as const) {
      const mp = pis[k];
      const e = mp.get(rm.p[i]);
      if (e) { e.n++; e.unidades += rm.q[i]; } else mp.set(rm.p[i], { n: 1, unidades: rm.q[i] });
    }
  }
  v.rms = rmsVistas.size;
  v.rmsComFracionado = rmsFr.size;
  v.porMes = [...meses.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([mes, x]) => ({ mes, ...x }));
  for (const k of [0, 1, 2, 3] as const) {
    v.topPis[k] = [...pis[k].entries()]
      .sort((a, b) => b[1].n - a[1].n || b[1].unidades - a[1].unidades)
      .slice(0, 50)
      .map(([p, x]) => ({ pi: rm.pis[p][0], desc: rm.pis[p][1], ...x }));
  }
  return v;
}

/* ------------------------------------------------------------ Reposição do FR */

export interface ParamsRepo {
  janela: number; // dias da média de consumo; 0 = todo o histórico
  diasAlvo: number; // cobertura desejada no FR
  caixasLoc: number; // caixas que cabem numa LOC FR (padrão para todo PI)
  base: "total" | "sobra"; // o que consome o FR: o pedido fracionado inteiro ou só a sobra
  minPedidos: number; // mínimo de pedidos fracionados na janela para entrar na análise
}

export const PARAMS_PADRAO: ParamsRepo = { janela: 90, diasAlvo: 7, caixasLoc: 15, base: "total", minPedidos: 2 };

export type Situacao = "critico" | "atencao" | "ok";

export interface ItemRepo {
  pi: string;
  desc: string;
  cxp: number;
  pedidosFr: number; // pedidos fracionados na janela
  unidadesFr: number; // unidades consumidas do FR na janela
  media: number; // unidades/dia
  estFr: number;
  estSc: number;
  locsFr: number;
  caixasLoc: number; // efetivo (padrão ou ajustado)
  capacidade: number; // unidades que cabem no(s) LOC(s) FR
  cobertura: number; // dias de cobertura atual no FR (Infinity se sem consumo)
  coberturaMax: number; // dias que a LOC cheia duraria
  situacao: Situacao;
  locInsuficiente: boolean;
  caixasNecessarias: number; // caixas para cobrir diasAlvo
  caixasRepor: number; // sugestão limitada pelo espaço
  faltaSc: boolean; // SC não tem o que precisa para repor
  opcoes: { caixas: number; dias: number }[];
  sugestoes: string[];
}

export interface EstoquePi { fr: number; sc: number; locs: Set<string> }

/** Saldo LIVRE por PI nas áreas FR/SC dos depósitos que contam como estoque. */
export function estoquePorPi(dados: Dados | null): Map<string, EstoquePi> {
  const m = new Map<string, EstoquePi>();
  if (!dados) return m;
  for (const l of dados.linhas) {
    if (dados.escopos[l.dep] !== "estoque" || !l.livre || l.disp <= 0) continue;
    if (l.area !== "FR" && l.area !== "SC") continue;
    let e = m.get(l.pi);
    if (!e) m.set(l.pi, (e = { fr: 0, sc: 0, locs: new Set() }));
    if (l.area === "FR") { e.fr += l.disp; e.locs.add(l.dep + "|" + l.end); } else e.sc += l.disp;
  }
  return m;
}

const fmt1 = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

export function calcReposicao(
  rm: RmDados,
  est: Map<string, EstoquePi>,
  params: ParamsRepo,
  caixasPorPi: Record<string, number>
): { itens: ItemRepo[]; janelaDias: number; ultimoDia: number } {
  let ultimo = -Infinity, primeiro = Infinity;
  for (const d of rm.d) { if (d > ultimo) ultimo = d; if (d < primeiro) primeiro = d; }
  if (!rm.d.length) return { itens: [], janelaDias: 0, ultimoDia: 0 };
  const span = ultimo - primeiro + 1;
  const janelaDias = params.janela > 0 ? Math.min(params.janela, span) : span;
  const dMin = ultimo - janelaDias + 1;

  const acc = new Map<number, { n: number; un: number; cxpFreq: Map<number, number> }>();
  for (let i = 0; i < rm.p.length; i++) {
    if (rm.d[i] < dMin) continue;
    const cl = classificar(rm.q[i], rm.c[i]);
    if (cl.grupo === 0) continue;
    let a = acc.get(rm.p[i]);
    if (!a) acc.set(rm.p[i], (a = { n: 0, un: 0, cxpFreq: new Map() }));
    a.n++;
    a.un += params.base === "total" ? rm.q[i] : cl.sobra;
    a.cxpFreq.set(rm.c[i], (a.cxpFreq.get(rm.c[i]) ?? 0) + 1);
  }

  const itens: ItemRepo[] = [];
  for (const [p, a] of acc) {
    if (a.n < params.minPedidos) continue;
    const [pi, desc] = rm.pis[p];
    const cxp = [...a.cxpFreq.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const e = est.get(pi);
    const estFr = e?.fr ?? 0, estSc = e?.sc ?? 0;
    const locsFr = Math.max(1, e?.locs.size ?? 0);
    const caixasLoc = caixasPorPi[pi] > 0 ? caixasPorPi[pi] : params.caixasLoc;
    const capacidade = caixasLoc * cxp * locsFr;
    const media = a.un / janelaDias;
    const cobertura = media > 0 ? estFr / media : Infinity;
    const coberturaMax = media > 0 ? capacidade / media : Infinity;
    const locInsuficiente = coberturaMax < params.diasAlvo;
    const caixasNecessarias = Math.ceil((params.diasAlvo * media) / cxp - 1e-9);
    const falta = Math.max(0, params.diasAlvo * media - estFr);
    const caixasPrecisa = Math.ceil(falta / cxp - 1e-9);
    const espaco = Math.max(0, Math.floor((capacidade - estFr) / cxp + 1e-9));
    const caixasRepor = Math.min(caixasPrecisa, espaco);
    const situacao: Situacao = estFr <= 0 || cobertura < params.diasAlvo * 0.4 ? "critico" : cobertura < params.diasAlvo ? "atencao" : "ok";
    const faltaSc = caixasRepor > 0 && estSc < caixasRepor * cxp;

    const opcoes = [...new Set([5, 10, 15, 20, 30, caixasNecessarias].filter((x) => x > 0))]
      .sort((x, y) => x - y)
      .map((caixas) => ({ caixas, dias: (caixas * cxp) / media }));

    const sugestoes: string[] = [];
    if (locInsuficiente) {
      const locsNec = Math.ceil(caixasNecessarias / caixasLoc);
      sugestoes.push(
        `A LOC FR cheia (${caixasLoc} caixas = ${fmt1(capacidade)} un) dura só ${fmt1(coberturaMax)} dias; a meta é ${params.diasAlvo}.`,
        `Opção A: ${locsNec} LOCs FR para este PI (${caixasNecessarias} caixas cobrem ${params.diasAlvo} dias).`,
        coberturaMax >= 1
          ? `Opção B: manter ${locsFr > 1 ? locsFr + " LOCs" : "1 LOC"} e recompletar a cada ${Math.floor(coberturaMax)} dia(s).`
          : `Opção B: recompletar mais de uma vez por dia (consumo ≈ ${fmt1(media / cxp)} caixas/dia).`,
        `Opção C: aumentar a LOC para ${Math.ceil(caixasNecessarias / locsFr)} caixas.`
      );
    }
    if (caixasRepor > 0 && faltaSc) {
      sugestoes.push(`Saldo livre em SC (${fmt1(estSc)} un) não cobre as ${caixasRepor} caixas sugeridas; verifique outras origens/recebimento.`);
    }
    itens.push({ pi, desc, cxp, pedidosFr: a.n, unidadesFr: a.un, media, estFr, estSc, locsFr, caixasLoc, capacidade, cobertura, coberturaMax, situacao, locInsuficiente, caixasNecessarias, caixasRepor, faltaSc, opcoes, sugestoes });
  }
  const peso = { critico: 0, atencao: 1, ok: 2 } as const;
  itens.sort((x, y) => peso[x.situacao] - peso[y.situacao] || x.cobertura - y.cobertura || y.media - x.media);
  return { itens, janelaDias, ultimoDia: ultimo };
}
