import type { RmDados } from "./rm";
import { DEPOSITOS_FORA_REPOSICAO } from "./config";
import { demandaFracionada } from "./demandaFr";
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
  janela: number; // dias usados só para a média de saída (informativa); 0 = todo o histórico
  caixasLoc: number; // caixas que cabem numa LOC FR (padrão para todo PI)
}

export const PARAMS_PADRAO: ParamsRepo = { janela: 90, caixasLoc: 15 };

/** Alerta: todo PI que já teve fracionado precisa de pelo menos 1 caixa padrão no FR. */
export type Situacao = "critico" | "atencao" | "ok";

export const DIAS_ALOCACAO = [7, 11];

export interface Alocacao {
  dias: number;
  caixas: number; // caixas para cobrir `dias` na média de saída
  locs: number; // LOCs FR necessárias
  distribuicao: number[]; // caixas em cada LOC (ex.: [15, 15, 8])
  locsNovas: number; // LOCs além das que o PI já ocupa
  repor: number; // caixas a trazer, descontado o que já está no FR
}

export interface ItemRepo {
  pi: string;
  desc: string;
  cxp: number;
  pedidosFr: number; // pedidos fracionados em todo o histórico
  ultimoFr: number; // dia do último pedido fracionado
  media: number; // unidades/dia de sobra na janela (usado só nas alocações de 7 e 11 dias)
  qtdMediaPedido: number; // média de unidades por pedido fracionado (sobra)
  freqTexto: string; // frequência média de pedidos fracionados
  mesesAtivos: number;
  mesesSpan: number;
  estFr: number;
  estSc: number;
  bloq: number; // saldo bloqueado (depósitos de estoque)
  motivosBloq: Record<string, number>;
  locsFr: number;
  caixasLoc: number; // efetivo (padrão ou ajustado)
  cobertura: number; // dias de cobertura atual no FR pela média (Infinity se sem consumo)
  situacao: Situacao;
  caixasRepor: number; // 1 caixa quando o FR está abaixo de 1 caixa
  scInsuficiente: boolean; // SC não tem 1 caixa para repor
  opcoes: { caixas: number; dias: number }[];
  alocacoes: Alocacao[];
}

export interface EstoquePi {
  fr: number; // livre, área FR
  sc: number; // livre, área SC
  locs: Set<string>;
  bloq: number;
  motivos: Record<string, number>;
  noP04: boolean; // tem saldo em depósito fora da reposição
}

/** Saldos por PI nos depósitos que contam como estoque. */
export function estoquePorPi(dados: Dados | null): Map<string, EstoquePi> {
  const m = new Map<string, EstoquePi>();
  if (!dados) return m;
  for (const l of dados.linhas) {
    if (dados.escopos[l.dep] !== "estoque") continue;
    const foraReposicao = DEPOSITOS_FORA_REPOSICAO.includes(l.dep) && (l.disp > 0 || l.total > 0); // inclui só reservado/reposição
    if (l.disp <= 0 && !foraReposicao) continue;
    let e = m.get(l.pi);
    if (!e) m.set(l.pi, (e = { fr: 0, sc: 0, locs: new Set(), bloq: 0, motivos: {}, noP04: false }));
    if (foraReposicao) e.noP04 = true;
    if (l.disp <= 0) continue;
    if (!l.livre) {
      e.bloq += l.disp;
      const mt = l.motivo || "SEM MOTIVO";
      e.motivos[mt] = (e.motivos[mt] ?? 0) + l.disp;
    } else if (l.area === "FR") {
      e.fr += l.disp;
      e.locs.add(l.dep + "|" + l.end);
    } else if (l.area === "SC") e.sc += l.disp;
  }
  return m;
}

export interface TotaisRepo {
  fracionados: number; // PIs com ao menos 1 pedido fracionado no histórico
  noP04: number; // ignorados por terem saldo no P04
  semScSemBloq: number; // ignorados: SC zerado e nada bloqueado
  visiveis: number;
}

export function calcReposicao(
  rm: RmDados,
  est: Map<string, EstoquePi>,
  params: ParamsRepo,
  caixasPorPi: Record<string, number>
): { itens: ItemRepo[]; janelaDias: number; ultimoDia: number; totais: TotaisRepo } {
  const totais: TotaisRepo = { fracionados: 0, noP04: 0, semScSemBloq: 0, visiveis: 0 };
  let ultimo = -Infinity, primeiro = Infinity;
  for (const d of rm.d) { if (d > ultimo) ultimo = d; if (d < primeiro) primeiro = d; }
  if (!rm.d.length) return { itens: [], janelaDias: 0, ultimoDia: 0, totais };
  const span = ultimo - primeiro + 1;
  const janelaDias = params.janela > 0 ? Math.min(params.janela, span) : span;
  const dMin = ultimo - janelaDias + 1;

  // caixa padrão vigente = a da linha mais recente do PI
  const cxpAtual = new Map<number, { dia: number; cxp: number }>();
  const acc = new Map<number, { n: number; ultimo: number; sobraJanela: number }>();
  for (let i = 0; i < rm.p.length; i++) {
    const p = rm.p[i];
    const c = cxpAtual.get(p);
    if (!c || rm.d[i] >= c.dia) cxpAtual.set(p, { dia: rm.d[i], cxp: rm.c[i] });
    const cl = classificar(rm.q[i], rm.c[i]);
    if (cl.grupo === 0) continue;
    let a = acc.get(p);
    if (!a) acc.set(p, (a = { n: 0, ultimo: -Infinity, sobraJanela: 0 }));
    a.n++;
    if (rm.d[i] > a.ultimo) a.ultimo = rm.d[i];
    if (rm.d[i] >= dMin) a.sobraJanela += cl.sobra; // o FR só é consumido pela sobra
  }

  const demandaPi = demandaFracionada(rm);
  const itens: ItemRepo[] = [];
  for (const [p, a] of acc) {
    totais.fracionados++;
    const [pi, desc] = rm.pis[p];
    const e = est.get(pi);
    if (e?.noP04) { totais.noP04++; continue; }
    const estFr = e?.fr ?? 0, estSc = e?.sc ?? 0, bloq = e?.bloq ?? 0;
    if (estSc <= 0 && bloq <= 0) { totais.semScSemBloq++; continue; }
    totais.visiveis++;

    const cxp = cxpAtual.get(p)!.cxp;
    const locsFr = Math.max(1, e?.locs.size ?? 0);
    const caixasLoc = caixasPorPi[pi] > 0 ? caixasPorPi[pi] : params.caixasLoc;
    const media = a.sobraJanela / janelaDias;
    const cobertura = media > 0 ? estFr / media : Infinity;
    const situacao: Situacao = estFr <= 0 ? "critico" : estFr < cxp ? "atencao" : "ok";
    const caixasRepor = situacao === "ok" ? 0 : 1;

    const opcoes = media > 0
      ? [5, 10, 15, 20, 30].map((caixas) => ({ caixas, dias: (caixas * cxp) / media }))
      : [];
    const alocacoes: Alocacao[] = media > 0
      ? DIAS_ALOCACAO.map((dias) => {
          const caixas = Math.max(1, Math.ceil((dias * media) / cxp - 1e-9));
          const locs = Math.ceil(caixas / caixasLoc);
          const distribuicao = Array.from({ length: locs }, (_, k) => (k < locs - 1 ? caixasLoc : caixas - caixasLoc * (locs - 1)));
          const repor = Math.max(0, Math.ceil((caixas * cxp - estFr) / cxp - 1e-9));
          return { dias, caixas, locs, distribuicao, locsNovas: Math.max(0, locs - (e?.locs.size ?? 0)), repor };
        })
      : [];

    itens.push({
      pi, desc, cxp, pedidosFr: a.n, ultimoFr: a.ultimo, media,
      qtdMediaPedido: demandaPi.get(pi)?.qtdMediaPedido ?? 0, freqTexto: demandaPi.get(pi)?.freqTexto ?? "—",
      mesesAtivos: demandaPi.get(pi)?.mesesAtivos ?? 0, mesesSpan: demandaPi.get(pi)?.mesesSpan ?? 0, estFr, estSc, bloq, motivosBloq: e?.motivos ?? {},
      locsFr, caixasLoc, cobertura, situacao, caixasRepor, scInsuficiente: caixasRepor > 0 && estSc < cxp, opcoes, alocacoes,
    });
  }
  const peso = { critico: 0, atencao: 1, ok: 2 } as const;
  itens.sort((x, y) => peso[x.situacao] - peso[y.situacao] || y.media - x.media || y.pedidosFr - x.pedidosFr);
  return { itens, janelaDias, ultimoDia: ultimo, totais };
}

/* ------------------------------------------------------------------ Diagnóstico */

export interface Diagnostico {
  pisTotal: number; // PIs distintos nos pedidos (sem cancelados)
  semCxp: number; // PIs cujas linhas não têm CXP válido: não dá para classificar
  cxpUm: number; // PIs com caixa padrão = 1 (todo pedido é múltiplo)
  soCaixaFechada: number; // CXP > 1, mas nunca houve sobra
  fracionadoHistorico: number; // PIs com ao menos 1 pedido fracionado em todo o histórico
}

export function diagnostico(rm: RmDados): Diagnostico {
  const n = rm.pis.length;
  const todasCxp1 = new Array<boolean>(n).fill(true);
  const frac = new Array<boolean>(n).fill(false);
  for (let i = 0; i < rm.p.length; i++) {
    const p = rm.p[i];
    if (rm.c[i] !== 1) todasCxp1[p] = false;
    if (classificar(rm.q[i], rm.c[i]).grupo !== 0) frac[p] = true;
  }
  const d: Diagnostico = { pisTotal: rm.resumo.pisTotal, semCxp: Math.max(0, rm.resumo.pisTotal - n), cxpUm: 0, soCaixaFechada: 0, fracionadoHistorico: 0 };
  for (let p = 0; p < n; p++) {
    if (frac[p]) d.fracionadoHistorico++;
    else if (todasCxp1[p]) d.cxpUm++;
    else d.soCaixaFechada++;
  }
  return d;
}
