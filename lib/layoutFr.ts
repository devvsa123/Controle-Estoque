import { DEPOSITOS_FORA_REPOSICAO, RUAS_FORA_LAYOUT_FR } from "./config";
import type { RmDados } from "./rm";
import { classificar } from "./rmAnalise";
import type { Dados } from "./types";

export interface ItemLoc {
  pi: string;
  qtd: number; // DISPONIVEL somado (livre + bloqueado)
  bloq: number; // parte bloqueada
  linhas: number;
}

export interface LocFr {
  loc: string; // dep|endereço
  dep: string;
  end: string;
  rua: string;
  itens: ItemLoc[]; // ordenado do maior para o menor saldo
  qtd: number;
}

export interface PiFr {
  pi: string;
  qtd: number;
  locs: { loc: string; dep: string; end: string; qtd: number }[]; // ordenado por saldo
  deps: string[];
}

export interface LayoutFr {
  locs: LocFr[];
  pis: Map<string, PiFr>;
}

/** Rua = primeiro número do endereço (12-01-01-AA → 12). */
export function ruaDe(end: string): string {
  return end.split("-")[0].trim();
}

export function ruaForaDoLayout(dep: string, end: string): boolean {
  const n = Number(ruaDe(end));
  return Number.isFinite(n) && RUAS_FORA_LAYOUT_FR.some((r) => r.dep === dep && r.rua === n);
}

/** LOCs da área FR dos depósitos de estoque, exceto os fora da reposição (P04) e as ruas ignoradas (ex.: P02 rua 12). */
export function montarLayout(dados: Dados, incluirBloqueados: boolean, deps: string[] = []): LayoutFr {
  const locs = new Map<string, LocFr>();
  for (const l of dados.linhas) {
    if (dados.escopos[l.dep] !== "estoque" || l.area !== "FR" || DEPOSITOS_FORA_REPOSICAO.includes(l.dep)) continue;
    if (deps.length && !deps.includes(l.dep)) continue;
    if (ruaForaDoLayout(l.dep, l.end)) continue;
    if (!(l.disp > 0 || l.total > 0)) continue; // LOC sem nada
    if (!incluirBloqueados && !l.livre) continue;
    const k = l.dep + "|" + l.end;
    let loc = locs.get(k);
    if (!loc) locs.set(k, (loc = { loc: k, dep: l.dep, end: l.end, rua: ruaDe(l.end) || "—", itens: [], qtd: 0 }));
    let it = loc.itens.find((x) => x.pi === l.pi);
    if (!it) loc.itens.push((it = { pi: l.pi, qtd: 0, bloq: 0, linhas: 0 }));
    it.qtd += l.disp;
    if (!l.livre) it.bloq += l.disp;
    it.linhas++;
    loc.qtd += l.disp;
  }
  const pis = new Map<string, PiFr>();
  for (const loc of locs.values()) {
    loc.itens.sort((a, b) => b.qtd - a.qtd);
    for (const it of loc.itens) {
      let p = pis.get(it.pi);
      if (!p) pis.set(it.pi, (p = { pi: it.pi, qtd: 0, locs: [], deps: [] }));
      p.qtd += it.qtd;
      p.locs.push({ loc: loc.loc, dep: loc.dep, end: loc.end, qtd: it.qtd });
      if (!p.deps.includes(loc.dep)) p.deps.push(loc.dep);
    }
  }
  for (const p of pis.values()) p.locs.sort((a, b) => b.qtd - a.qtd);
  return { locs: [...locs.values()], pis };
}

/* ------------------------------------------------------------- dados dos pedidos */

export interface InfoPedidos {
  cxp: Map<string, number>; // caixa padrão vigente por PI
  fracionadoNaJanela: Set<string>; // PIs com ao menos 1 pedido fracionado na janela
  ultimoDia: number;
}

export function infoPedidos(rm: RmDados, janelaDias: number): InfoPedidos {
  let ultimo = -Infinity, primeiro = Infinity;
  for (const d of rm.d) { if (d > ultimo) ultimo = d; if (d < primeiro) primeiro = d; }
  const dMin = janelaDias > 0 ? ultimo - janelaDias + 1 : -Infinity;
  const ult = new Map<number, { dia: number; cxp: number }>();
  const frac = new Set<string>();
  for (let i = 0; i < rm.p.length; i++) {
    const p = rm.p[i];
    const c = ult.get(p);
    if (!c || rm.d[i] >= c.dia) ult.set(p, { dia: rm.d[i], cxp: rm.c[i] });
    if (rm.d[i] >= dMin && classificar(rm.q[i], rm.c[i]).grupo !== 0) frac.add(rm.pis[p][0]);
  }
  const cxp = new Map<string, number>();
  for (const [p, v] of ult) cxp.set(rm.pis[p][0], v.cxp);
  return { cxp, fracionadoNaJanela: frac, ultimoDia: ultimo };
}

/* ------------------------------------------------------------------ estatísticas */

export interface FaixaDist { rotulo: string; locs: number; unidades: number }

const FAIXAS_PIS = [
  { r: "1 PI", min: 1, max: 1 }, { r: "2 PIs", min: 2, max: 2 }, { r: "3 PIs", min: 3, max: 3 },
  { r: "4 PIs", min: 4, max: 4 }, { r: "5 PIs", min: 5, max: 5 }, { r: "6 a 9 PIs", min: 6, max: 9 }, { r: "10+ PIs", min: 10, max: Infinity },
];
const FAIXAS_LOCS = [
  { r: "1 LOC", min: 1, max: 1 }, { r: "2 LOCs", min: 2, max: 2 }, { r: "3 LOCs", min: 3, max: 3 },
  { r: "4 LOCs", min: 4, max: 4 }, { r: "5 a 9 LOCs", min: 5, max: 9 }, { r: "10+ LOCs", min: 10, max: Infinity },
];

export interface ResumoPaiol {
  dep: string;
  locs: number;
  pis: number;
  locsMulti: number; // LOCs com mais de um PI
  mediaPis: number;
  maxPis: number;
  unidades: number;
  unidadesEmMulti: number;
  pisEmVariasLocs: number;
  paresPiLoc: number;
  movimentosMin: number; // pares PI×LOC − LOCs: cada LOC mantém só 1 PI
  unidadesAMover: number; // saldo dos PIs que não são o dominante da LOC
}

export interface Estatisticas {
  total: ResumoPaiol;
  porPaiol: ResumoPaiol[];
  distPisPorLoc: FaixaDist[];
  distLocsPorPi: { rotulo: string; pis: number; unidades: number }[];
  pisEmVariosPaiois: number;
  porRua: { dep: string; rua: string; locs: number; locsMulti: number; pis: number; unidades: number }[];
}

function resumir(dep: string, locs: LocFr[], pis: Map<string, PiFr>): ResumoPaiol {
  const pisDep = new Set<string>();
  let multi = 0, soma = 0, max = 0, un = 0, unMulti = 0, pares = 0, aMover = 0;
  for (const l of locs) {
    const n = l.itens.length;
    soma += n; if (n > max) max = n; un += l.qtd; pares += n;
    if (n > 1) { multi++; unMulti += l.qtd; aMover += l.qtd - l.itens[0].qtd; }
    for (const it of l.itens) pisDep.add(it.pi);
  }
  let variasLocs = 0;
  for (const pi of pisDep) {
    const p = pis.get(pi)!;
    const n = dep === "TOTAL" ? p.locs.length : p.locs.filter((x) => x.dep === dep).length;
    if (n > 1) variasLocs++;
  }
  return { dep, locs: locs.length, pis: pisDep.size, locsMulti: multi, mediaPis: locs.length ? soma / locs.length : 0, maxPis: max, unidades: un, unidadesEmMulti: unMulti, pisEmVariasLocs: variasLocs, paresPiLoc: pares, movimentosMin: pares - locs.length, unidadesAMover: aMover };
}

export function estatisticas(lay: LayoutFr): Estatisticas {
  const deps = [...new Set(lay.locs.map((l) => l.dep))].sort();
  const porPaiol = deps.map((d) => resumir(d, lay.locs.filter((l) => l.dep === d), lay.pis));
  const dist: FaixaDist[] = FAIXAS_PIS.map((f) => ({ rotulo: f.r, locs: 0, unidades: 0 }));
  for (const l of lay.locs) {
    const i = FAIXAS_PIS.findIndex((f) => l.itens.length >= f.min && l.itens.length <= f.max);
    dist[i].locs++; dist[i].unidades += l.qtd;
  }
  const distLocs = FAIXAS_LOCS.map((f) => ({ rotulo: f.r, pis: 0, unidades: 0 }));
  let variosPaiois = 0;
  for (const p of lay.pis.values()) {
    const i = FAIXAS_LOCS.findIndex((f) => p.locs.length >= f.min && p.locs.length <= f.max);
    distLocs[i].pis++; distLocs[i].unidades += p.qtd;
    if (p.deps.length > 1) variosPaiois++;
  }
  const ruas = new Map<string, { dep: string; rua: string; locs: number; locsMulti: number; pis: Set<string>; unidades: number }>();
  for (const l of lay.locs) {
    const k = l.dep + "|" + l.rua;
    let r = ruas.get(k);
    if (!r) ruas.set(k, (r = { dep: l.dep, rua: l.rua, locs: 0, locsMulti: 0, pis: new Set(), unidades: 0 }));
    r.locs++; r.unidades += l.qtd; if (l.itens.length > 1) r.locsMulti++;
    for (const it of l.itens) r.pis.add(it.pi);
  }
  return {
    total: resumir("TOTAL", lay.locs, lay.pis),
    porPaiol,
    distPisPorLoc: dist,
    distLocsPorPi: distLocs,
    pisEmVariosPaiois: variosPaiois,
    porRua: [...ruas.values()].map((r) => ({ dep: r.dep, rua: r.rua, locs: r.locs, locsMulti: r.locsMulti, pis: r.pis.size, unidades: r.unidades }))
      .sort((a, b) => a.dep.localeCompare(b.dep) || a.rua.localeCompare(b.rua, "pt-BR", { numeric: true })),
  };
}

/* -------------------------------------------------------------------- simulação */

export interface ParamsSim {
  caixasLoc: number;
  caixasPorPi: Record<string, number>;
  /** Se informado, só estes PIs seguem no FR (os demais são candidatos a sair). */
  manter: Set<string> | null;
}

export interface LinhaSim {
  dep: string;
  locsAtuais: number;
  pisNoFr: number;
  pisConsiderados: number; // PIs que ficariam no FR do paiol
  locsUmPorPi: number; // 1 LOC de picking por PI (= PIs considerados)
  saldo: number; // 1 por PI − LOCs atuais (positivo = faltam LOCs vazias)
  pisComExcedente: number; // PIs cujo saldo passa da capacidade de 1 LOC
  excedente: number; // unidades além da capacidade de 1 LOC (teriam que ficar fora do FR)
  locsSeTudoNoFr: number; // LOCs necessárias se TODO o saldo ficasse no FR (várias LOCs por PI)
  pisSemCxp: number; // sem caixa padrão conhecida: assumido 1 LOC
  pisNaoCabem: number; // PIs que precisam de mais de 1 LOC
  pisFora: number; // PIs sem giro fracionado (candidatos a sair do FR)
  unidadesFora: number;
}

function capacidade(pi: string, info: InfoPedidos | null, p: ParamsSim): number | null {
  const cx = info?.cxp.get(pi);
  if (!cx) return null;
  return (p.caixasPorPi[pi] > 0 ? p.caixasPorPi[pi] : p.caixasLoc) * cx;
}

/** 1 LOC de picking por PI, por paiol e no total (PI único em todo o FR). O que passa da capacidade da LOC é excedente. */
export function simular(lay: LayoutFr, info: InfoPedidos | null, p: ParamsSim): LinhaSim[] {
  const deps = [...new Set(lay.locs.map((l) => l.dep))].sort();
  const linha = (dep: string): LinhaSim => {
    const locsDep = dep === "TOTAL" ? lay.locs : lay.locs.filter((l) => l.dep === dep);
    const qtdPi = new Map<string, number>();
    for (const l of locsDep) for (const it of l.itens) qtdPi.set(it.pi, (qtdPi.get(it.pi) ?? 0) + it.qtd);
    const r: LinhaSim = { dep, locsAtuais: locsDep.length, pisNoFr: qtdPi.size, pisConsiderados: 0, locsUmPorPi: 0, saldo: 0, pisComExcedente: 0, excedente: 0, locsSeTudoNoFr: 0, pisSemCxp: 0, pisNaoCabem: 0, pisFora: 0, unidadesFora: 0 };
    for (const [pi, q] of qtdPi) {
      if (p.manter && !p.manter.has(pi)) { r.pisFora++; r.unidadesFora += q; continue; }
      r.pisConsiderados++;
      r.locsUmPorPi++;
      const cap = capacidade(pi, info, p);
      if (cap === null) { r.pisSemCxp++; r.locsSeTudoNoFr += 1; continue; }
      const n = Math.max(1, Math.ceil(q / cap - 1e-9));
      if (n > 1) { r.pisNaoCabem++; r.pisComExcedente++; r.excedente += q - cap; }
      r.locsSeTudoNoFr += n;
    }
    r.saldo = r.locsUmPorPi - r.locsAtuais;
    return r;
  };
  return [...deps.map(linha), linha("TOTAL")];
}
