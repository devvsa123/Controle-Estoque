import { CALCADOS_PRIMEIRA_PALAVRA, DEPOSITOS_FORA_REPOSICAO, NIVEL_SC_REPOSICAO, ZONA_BAIXO_GIRO } from "./config";
import { demandaFracionada, type DemandaFr } from "./demandaFr";
import { montarLayout, ruaDe, ruaForaDoLayout } from "./layoutFr";
import { chaveRota } from "./rota";
import type { RmDados } from "./rm";
import { auditar } from "./auditoria";
import { estoquePorPi } from "./rmAnalise";
import type { Dados, Linha } from "./types";
import {
  ABERTA, EM_ANDAMENTO, type Alerta, type AvisoValidacao, type Conformidade, type EstadoMissoes, type Local, type Missao, type Parametros, type TipoMissao,
} from "./missoes";

/* =====================================================================================
 *  PADRÃO DE ENDEREÇAMENTO DO FRACIONADO (o que o planejador persegue)
 *
 *  1. Cada PI com pedido fracionado tem UMA LOC FR "casa", só dele (1 PI por LOC).
 *  2. Na casa: no mínimo `minCaixas` e no máximo `maxCaixas` caixas padrão
 *     (calçados, de caixa grande: `maxCaixasCalcado`). Abaixo do mínimo → recompleta de SC;
 *     acima do máximo → o excedente volta para SC.
 *  3. O recompletamento leva a casa até `pedidosCobertura` pedidos fracionados médios
 *     (média da sobra por pedido), entre o mínimo e o máximo.
 *  4. Faltou LOC? Os PIs de MENOR saída vão para a zona de baixo giro (rua 01 do P02),
 *     com `caixasZona` caixas de cada um, vários PIs por LOC.
 *  5. P04 e a rua 12 do P02 ficam fora. PIs com saldo no P04 não são tocados.
 *
 *  O planejador é determinístico e parte da planilha + as missões ainda em andamento
 *  (tratadas como já feitas): o mesmo estoque devolve as mesmas missões, e só o que foge
 *  do padrão gera missão nova. Cada missão guarda uma "foto" da origem/destino para a
 *  próxima planilha confirmar se foi cumprida.
 * ===================================================================================== */

const EPS = 1e-9;
const DIA = 86400000;
const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

export const chaveLoc = (l: Local) => `${l.dep}|${l.end}`;
const locDe = (k: string): Local => { const i = k.indexOf("|"); return { dep: k.slice(0, i), end: k.slice(i + 1) }; };
const ehZona = (l: Local) => l.dep === ZONA_BAIXO_GIRO.dep && Number(ruaDe(l.end)) === ZONA_BAIXO_GIRO.rua;

export { chaveRota } from "./rota";

export interface Limites {
  cxp: number;
  minCx: number;
  maxCx: number;
  minUn: number;
  maxUn: number;
  calcado: boolean;
}

export interface Contexto {
  dados: Dados;
  rm: RmDados | null;
  params: Parametros;
  estoqueEm: string;
  est: ReturnType<typeof estoquePorPi>;
  dem: Map<string, DemandaFr>;
  linhasSc: Map<string, Linha[]>; // por PI: linhas SC livres
  ocupFr: Map<string, Set<string>>; // LOC FR → PIs presentes (qualquer status), exceto P04
  livreLoc: Map<string, number>; // "pi|dep|end" → saldo livre
  livrePorId: Map<string, number>; // ID_QUANT → saldo livre
  areasLoc: Map<string, Set<string>>;
  scQtd: Map<string, Map<string, number>>; // LOC SC → PI → saldo total (qualquer status), para a capacidade em caixas
  produtoDesc: (pi: string) => string;
  cxpDe: (pi: string) => number | undefined; // caixa padrão: coluna CXP da planilha de estoque ou, na falta, a dos pedidos
  scCaixas: (loc: string) => number; // caixas em uma LOC de SC somando TODOS os PIs (Infinity se algum PI não tem caixa padrão conhecida)
  ehCalcado: (pi: string) => boolean;
  limites: (pi: string) => Limites | null;
}

export interface Proposta extends Omit<Missao, "id" | "origem" | "status" | "criadaEm" | "atualizadoEm" | "concluidaEm" | "verificadaEm" | "motivoCancelamento" | "responsavel" | "obs" | "nota"> {
  nota: string;
}

/* ------------------------------------------------------------------ contexto */

export function montarContexto(dados: Dados, rm: RmDados | null, paramsEntrada: Parametros): Contexto {
  let params = paramsEntrada;
  const linhasSc = new Map<string, Linha[]>();
  const ocupFr = new Map<string, Set<string>>();
  const livreLoc = new Map<string, number>();
  const livrePorId = new Map<string, number>();
  const areasLoc = new Map<string, Set<string>>();
  const scQtd = new Map<string, Map<string, number>>();
  for (const l of dados.linhas) {
    if (dados.escopos[l.dep] !== "estoque") continue;
    const k = l.dep + "|" + l.end;
    if (l.disp > 0 || l.total > 0) {
      (areasLoc.get(k) ?? areasLoc.set(k, new Set()).get(k)!).add(l.area);
      if (l.area === "SC") { const m = scQtd.get(k) ?? scQtd.set(k, new Map()).get(k)!; m.set(l.pi, (m.get(l.pi) ?? 0) + l.total); }
      if (l.area === "FR" && !DEPOSITOS_FORA_REPOSICAO.includes(l.dep)) (ocupFr.get(k) ?? ocupFr.set(k, new Set()).get(k)!).add(l.pi);
    }
    if (!l.livre || l.disp <= 0) continue;
    livreLoc.set(`${l.pi}|${k}`, (livreLoc.get(`${l.pi}|${k}`) ?? 0) + l.disp);
    livrePorId.set(l.id, (livrePorId.get(l.id) ?? 0) + l.disp);
    if (l.area === "SC") (linhasSc.get(l.pi) ?? linhasSc.set(l.pi, []).get(l.pi)!).push(l);
  }
  // LOC "vazia" informada que na planilha tem saldo em SC (ou, no caso de SC, qualquer saldo) não está vazia: descarta
  params = {
    ...paramsEntrada,
    locsVazias: paramsEntrada.locsVazias.filter((v) => !areasLoc.get(v.dep + "|" + v.end)?.has("SC")),
    locsVaziasSc: paramsEntrada.locsVaziasSc.filter((v) => !areasLoc.has(v.dep + "|" + v.end)),
  };
  const dem = demandaFracionada(rm);
  const calcado = (pi: string) => CALCADOS_PRIMEIRA_PALAVRA.includes((dados.produtos[pi]?.desc ?? "").trim().split(/\s+/)[0]?.toUpperCase());
  const cxpDe = (pi: string) => dados.produtos[pi]?.cxp || dem.get(pi)?.cxp || undefined;
  const scCaixas = (loc: string): number => {
    let v = 0;
    for (const [p, q] of scQtd.get(loc) ?? []) {
      if (q <= 0) continue;
      const c = cxpDe(p);
      if (!c) return Infinity; // não dá para saber quantas caixas há na LOC: tratada como cheia
      v += q / c;
    }
    return v;
  };
  const limites = (pi: string): Limites | null => {
    const cxp = cxpDe(pi);
    if (!cxp) return null;
    const cal = calcado(pi);
    const maxCx = params.caixasPorPi[pi] > 0 ? params.caixasPorPi[pi] : cal ? params.maxCaixasCalcado : params.maxCaixas;
    const minCx = Math.min(maxCx, cal ? params.minCaixasCalcado : params.minCaixas);
    return { cxp, minCx, maxCx, minUn: minCx * cxp, maxUn: maxCx * cxp, calcado: cal };
  };
  return {
    dados, rm, params, estoqueEm: dados.atualizadoEm ?? "", est: estoquePorPi(dados), dem, linhasSc, ocupFr, livreLoc, livrePorId, areasLoc, scQtd,
    produtoDesc: (pi) => dados.produtos[pi]?.desc ?? pi, cxpDe, scCaixas, ehCalcado: calcado, limites,
  };
}

/** Missões cujo efeito o planejamento deve tratar como já feito (abertas ou feitas e ainda não confirmadas). */
export const efetivas = (missoes: Missao[]) => missoes.filter((m) => EM_ANDAMENTO(m.status));

/* ------------------------------------------------------------------ simulação */

interface It { qtd: number; bloq: number }
type Sim = Map<string, Map<string, It>>;

function montarSim(ctx: Contexto, extras: string[] = []): Sim {
  const sim: Sim = new Map();
  for (const l of montarLayout(ctx.dados, true).locs) {
    const m = new Map<string, It>();
    for (const it of l.itens) m.set(it.pi, { qtd: it.qtd, bloq: it.bloq });
    sim.set(l.loc, m);
  }
  for (const k of extras) {
    const v = locDe(k);
    if (ctx.dados.escopos[v.dep] === "estoque" && !DEPOSITOS_FORA_REPOSICAO.includes(v.dep) && !ruaForaDoLayout(v.dep, v.end) && !sim.has(k)) sim.set(k, new Map());
  }
  for (const v of ctx.params.locsVazias) {
    const k = chaveLoc(v);
    if (ctx.dados.escopos[v.dep] === "estoque" && !DEPOSITOS_FORA_REPOSICAO.includes(v.dep) && !ruaForaDoLayout(v.dep, v.end) && !sim.has(k) && !ctx.areasLoc.get(k)?.has("SC")) sim.set(k, new Map());
  }
  return sim;
}

const qtdSim = (sim: Sim, k: string, pi: string) => sim.get(k)?.get(pi)?.qtd ?? 0;

function sairSim(sim: Sim, k: string, pi: string, q: number) {
  const it = sim.get(k)?.get(pi);
  if (!it) return;
  it.qtd -= q;
  if (it.qtd <= EPS && it.bloq <= EPS) sim.get(k)!.delete(pi);
}

function entrarSim(sim: Sim, k: string, pi: string, q: number) {
  let m = sim.get(k);
  if (!m) sim.set(k, (m = new Map()));
  const it = m.get(pi);
  if (it) it.qtd += q; else m.set(pi, { qtd: q, bloq: 0 });
}

/** Conformidade do estado ATUAL da planilha (sem missões): considera as LOCs que têm ao menos um PI com pedido fracionado. */
export function conformidade(ctx: Contexto): Conformidade {
  const sim = montarSim(ctx);
  const c: Conformidade = { locs: 0, conformes: 0, maisDeUmPi: 0, acimaDoMaximo: 0, abaixoDoMinimo: 0, pisSemLoc: 0 };
  const noFr = new Set<string>();
  for (const [k, itens] of sim) {
    if (itens.size === 0) continue;
    for (const pi of itens.keys()) noFr.add(pi);
    const ativos = [...itens.keys()].filter((pi) => ctx.dem.get(pi)?.frac && !ctx.est.get(pi)?.noP04);
    if (!ativos.length) continue; // LOC só de itens sem pedido fracionado: fora do escopo do padrão
    c.locs++;
    let ok = true;
    // 2 PIs na mesma LOC só valem quando faltam LOCs no paiol: ambos de fracionado e com até `caixasZona` caixas cada
    const compart = itens.size === 2 && ativos.length === 2 && ativos.every((pi) => Math.floor(itens.get(pi)!.qtd / ctx.limites(pi)!.cxp + EPS) <= ctx.params.caixasZona);
    if (itens.size > 1 && !compart) { c.maisDeUmPi++; ok = false; }
    for (const pi of ativos) {
      const lim = ctx.limites(pi)!, it = itens.get(pi)!;
      if (Math.floor(it.qtd / lim.cxp + EPS) > (compart ? Math.min(lim.maxCx, ctx.params.caixasZona) : lim.maxCx)) { c.acimaDoMaximo++; ok = false; }
      if (it.qtd < lim.minUn - EPS && itens.size === 1) { c.abaixoDoMinimo++; ok = false; }
    }
    if (ok) c.conformes++;
  }
  for (const [pi, d] of ctx.dem) {
    if (!d.frac || ctx.est.get(pi)?.noP04) continue;
    const e = ctx.est.get(pi);
    const temFr = noFr.has(pi) || [...ctx.ocupFr.values()].some((set) => set.has(pi));
    if (((e?.fr ?? 0) > 0 || (e?.sc ?? 0) >= d.cxp) && !temFr) c.pisSemLoc++;
  }
  return c;
}

/* ------------------------------------------------------------------ planejador */

export interface Plano {
  propostas: Proposta[];
  alertas: Alerta[];
  casas: Record<string, string>; // tabela mestre atualizada
  zona: Record<string, string>;
  resumo: { ativos: number; comCasa: number; naZona: number; semLugar: number; semLugarPis: string[] };
}

export function planejar(ctx: Contexto, efet: Missao[], casasPrev: Record<string, string> = {}, zonaPrev: Record<string, string> = {}): Plano {
  const { params } = ctx;
  const sim = montarSim(ctx, [...Object.values(casasPrev), ...Object.values(zonaPrev)]);
  const pendSc = new Map<string, number>();
  const nome = (pi: string) => `${pi} · ${ctx.produtoDesc(pi)}`;

  // missões em andamento contam como já feitas
  for (const m of efet) {
    const de = chaveLoc(m.de), para = chaveLoc(m.para);
    if (m.tipo === "recompletamento") {
      if (m.idQuant) pendSc.set(m.idQuant, (pendSc.get(m.idQuant) ?? 0) + m.qtd);
      entrarSim(sim, para, m.pi, m.qtd);
    } else {
      if (sim.has(de)) sairSim(sim, de, m.pi, m.qtd);
      if (sim.has(para) || ctx.areasLoc.get(para)?.has("FR") || ctx.params.locsVazias.some((v) => chaveLoc(v) === para)) entrarSim(sim, para, m.pi, m.qtd);
    }
  }

  const todasLocs = () => [...sim.keys()].sort();
  const primLocs = () => todasLocs();
  const protegido = (pi: string) => !!ctx.est.get(pi)?.noP04;

  // PIs ativos: já tiveram pedido fracionado, têm caixa padrão conhecida e algum saldo
  const scLivre = (pi: string) => (ctx.linhasSc.get(pi) ?? []).reduce((s, l) => s + Math.max(0, l.disp - (pendSc.get(l.id) ?? 0)), 0);
  const frTotal = (pi: string) => { let t = 0; for (const m of sim.values()) t += m.get(pi)?.qtd ?? 0; return t; };
  const ativos = [...ctx.dem.entries()]
    .filter(([pi, d]) => d.frac && !protegido(pi) && (frTotal(pi) > EPS || scLivre(pi) >= d.cxp - EPS))
    .sort((a, b) => b[1].n12 - a[1].n12 || b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .map(([pi]) => pi);
  const ehAtivo = new Set(ativos);

  // Paiol de cada PI ativo: o que tem MAIS saldo do PI (FR + SC). Tudo é resolvido dentro do paiol; a escolha só muda se o outro passar de 50% a mais.
  const depsSim = new Set([...sim.keys()].map((k) => locDe(k).dep));
  const totDep = new Map<string, Map<string, number>>();
  for (const l of ctx.dados.linhas) {
    if (!ehAtivo.has(l.pi) || !depsSim.has(l.dep) || ctx.dados.escopos[l.dep] !== "estoque") continue;
    const m = totDep.get(l.pi) ?? totDep.set(l.pi, new Map()).get(l.pi)!;
    m.set(l.dep, (m.get(l.dep) ?? 0) + l.total);
  }
  const paiolDe = new Map<string, string>();
  const paiolEfet = new Map<string, string>(); // destino de missão em andamento define o paiol
  for (const m of [...efet].sort((a, b) => (a.id < b.id ? -1 : 1))) if (m.tipo === "movimentacao" && sim.has(chaveLoc(m.para)) && !paiolEfet.has(m.pi)) paiolEfet.set(m.pi, m.para.dep);
  for (const pi of ativos) {
    const ord = [...(totDep.get(pi) ?? [])].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    let dep = ord[0]?.[0] ?? "";
    const prev = paiolEfet.get(pi) ?? (casasPrev[pi] ? locDe(casasPrev[pi]).dep : zonaPrev[pi] ? locDe(zonaPrev[pi]).dep : "");
    if (prev && prev !== dep && depsSim.has(prev) && (paiolEfet.has(pi) || (totDep.get(pi)?.get(prev) ?? 0) * 1.5 >= (totDep.get(pi)?.get(dep) ?? 0))) dep = prev;
    paiolDe.set(pi, dep);
  }
  const noPaiol = (pi: string, k: string) => locDe(k).dep === paiolDe.get(pi);

  // ---- 1) casa de cada PI ativo
  const casaLoc = new Map<string, string>(); // loc → pi
  const casaDe = new Map<string, string>(); // pi → loc
  const zonaPre = new Map<string, string>(); // pi → LOC da zona já definida por missão em andamento
  // 1.0) tabela mestre: a casa anterior continua valendo enquanto for válida (LOC existe no escopo e o PI segue ativo)
  for (const pi of ativos) {
    const k = casasPrev[pi];
    if (k && sim.has(k) && noPaiol(pi, k) && !casaLoc.has(k)) { casaLoc.set(k, pi); casaDe.set(pi, k); continue; }
    const z = zonaPrev[pi];
    if (z && sim.has(z) && noPaiol(pi, z)) zonaPre.set(pi, z);
  }
  // 1a) o destino de uma missão em andamento já é a casa do PI (o plano não muda de ideia entre planilhas)
  for (const m of [...efet].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!ehAtivo.has(m.pi) || casaDe.has(m.pi) || zonaPre.has(m.pi)) continue;
    const para = chaveLoc(m.para);
    if (!sim.has(para)) continue; // destino SC (devolução)
    if (zonaPrev[m.pi] === para) { zonaPre.set(m.pi, para); continue; }
    if (!casaLoc.has(para)) { casaLoc.set(para, m.pi); casaDe.set(m.pi, para); }
  }
  // 1b) senão, a LOC onde ele já está (sozinho e com mais saldo)
  for (const pi of ativos) {
    if (casaDe.has(pi) || zonaPre.has(pi)) continue;
    const cand = primLocs().filter((k) => noPaiol(pi, k) && qtdSim(sim, k, pi) > EPS && !casaLoc.has(k))
      .sort((a, b) => Number(sim.get(b)!.size === 1) - Number(sim.get(a)!.size === 1) || qtdSim(sim, b, pi) - qtdSim(sim, a, pi) || (a < b ? -1 : 1));
    if (cand.length) { casaLoc.set(cand[0], pi); casaDe.set(pi, cand[0]); }
  }

  // ---- SC: estado simulado (planilha + missões em andamento), 1 PI por LOC ao final, altura 02 = reposição, alturas 03+ = palete fechado
  const maxSc = (pi: string) => (ctx.ehCalcado(pi) ? params.maxCaixasScCalcado : params.maxCaixasSc);
  const nivelDe = (k: string) => Number(k.split("|")[1]?.split("-")[2]) || 0;
  interface ItSc { qtd: number; livre: number } // qtd = total (todos os status); livre = o que dá para movimentar
  const scSim = new Map<string, Map<string, ItSc>>();
  const linhaSc = new Map<string, Linha>(); // ID_QUANT → linha livre de SC
  const locDaLinha = new Map<string, string>(); // ID_QUANT → LOC atual (muda com missões de descer/consolidar)
  for (const l of ctx.dados.linhas) {
    if (l.area !== "SC" || !depsSim.has(l.dep) || ctx.dados.escopos[l.dep] !== "estoque" || !(l.total > 0 || l.disp > 0)) continue;
    const k = l.dep + "|" + l.end;
    const mp = scSim.get(k) ?? scSim.set(k, new Map()).get(k)!;
    const it = mp.get(l.pi) ?? mp.set(l.pi, { qtd: 0, livre: 0 }).get(l.pi)!;
    it.qtd += l.total; if (l.livre) it.livre += l.disp;
    if (l.livre && l.disp > 0) { linhaSc.set(l.id, l); locDaLinha.set(l.id, k); }
  }
  let versaoSc = 0; // muda a cada alteração do estado simulado do SC (invalida os caches abaixo)
  const scAdd = (k: string, pi: string, q: number) => {
    versaoSc++;
    const mp = scSim.get(k) ?? scSim.set(k, new Map()).get(k)!;
    const it = mp.get(pi) ?? mp.set(pi, { qtd: 0, livre: 0 }).get(pi)!;
    it.qtd += q; it.livre += q;
  };
  const scSub = (k: string, pi: string, q: number) => {
    versaoSc++;
    const it = scSim.get(k)?.get(pi);
    if (!it) return;
    it.qtd -= q; it.livre -= q;
    if (it.qtd <= EPS) scSim.get(k)!.delete(pi);
    if (scSim.get(k)!.size === 0) scSim.delete(k);
  };
  const ehLocFr = (k: string) => !!ctx.areasLoc.get(k)?.has("FR") || params.locsVazias.some((v) => chaveLoc(v) === k) || Object.values(casasPrev).includes(k) || Object.values(zonaPrev).includes(k);
  // missões em andamento já valem: mexem no estado simulado do SC
  for (const m of efet) {
    const de = chaveLoc(m.de), para = chaveLoc(m.para);
    if (m.tipo === "recompletamento") { scSub(de, m.pi, m.qtd); continue; }
    if (m.sub) {
      scSub(de, m.pi, m.qtd); scAdd(para, m.pi, m.qtd);
      for (const [id, k] of locDaLinha) { const l = linhaSc.get(id); if (l && l.pi === m.pi && k === de && (!m.idQuant || m.idQuant === id)) locDaLinha.set(id, para); }
    } else if (!ehLocFr(para)) scAdd(para, m.pi, m.qtd); // FR → SC (devolução)
  }
  const scPis = (k: string) => [...(scSim.get(k) ?? [])].filter(([, it]) => it.qtd > EPS).map(([pi]) => pi);
  const scBoxes = (k: string): number => {
    let v = 0;
    for (const [pi, it] of scSim.get(k) ?? []) { if (it.qtd <= EPS) continue; const c = ctx.cxpDe(pi); if (!c) return Infinity; v += it.qtd / c; }
    return v;
  };
  const roomSc = (pi: string, k: string) => Math.floor(maxSc(pi) - scBoxes(k) + EPS);
  const rotaCache = new Map<string, string>();
  const rotaMemo = (k: string) => rotaCache.get(k) ?? rotaCache.set(k, chaveRota(k)).get(k)!;
  const ruaDeLoc = (k: string) => k.split("|")[1]?.split("-")[0] ?? "";
  const locsScVazias = params.locsVaziasSc.map(chaveLoc);
  /** LOCs de SC vazias do paiol (de uma altura, se informada), as da mesma rua primeiro. Uma LOC já usada neste plano deixa de estar vazia. */
  const vaziasSc = (dep: string, nivel?: number, rua = "") =>
    locsScVazias.filter((k) => locDe(k).dep === dep && !ctx.areasLoc.has(k) && scPis(k).length === 0 && (nivel === undefined || nivelDe(k) === nivel))
      .sort((a, b) => Number(ruaDeLoc(b) === rua) - Number(ruaDeLoc(a) === rua) || (rotaMemo(a) < rotaMemo(b) ? -1 : 1));
  /** LOCs de reposição (altura 02) do paiol que só têm este PI: onde as caixas devolvidas do FR se juntam. */
  const pulmoesDoPi = (pi: string, dep: string) =>
    [...scSim.keys()].filter((k) => locDe(k).dep === dep && nivelDe(k) === NIVEL_SC_REPOSICAO && scPis(k).length > 0 && scPis(k).every((p) => p === pi))
      .sort((a, b) => scBoxes(b) - scBoxes(a) || (a < b ? -1 : 1));
  const temVaziaSc = (dep: string) => locsScVazias.some((k) => locDe(k).dep === dep && nivelDe(k) === NIVEL_SC_REPOSICAO && !ctx.areasLoc.has(k) && scPis(k).length === 0);
  /** Distribui `caixas` devolvidas entre as LOCs de altura 02 do PI (uma só dele) e, se faltar espaço, LOCs vazias de altura 02 do mesmo paiol. */
  const alocarSc = (pi: string, depOrigem: string, origemKey: string, caixas: number): { k: string; cx: number }[] => {
    const cands = [...pulmoesDoPi(pi, depOrigem), ...vaziasSc(depOrigem, NIVEL_SC_REPOSICAO, ruaDeLoc(origemKey))];
    const out: { k: string; cx: number }[] = [];
    let falta = caixas;
    const c = ctx.cxpDe(pi);
    for (const k of cands) {
      if (falta <= 0 || !c) break;
      const cx = Math.min(falta, roomSc(pi, k));
      if (cx <= 0) continue;
      out.push({ k, cx });
      scAdd(k, pi, cx * c);
      falta -= cx;
    }
    return out;
  };
  const cachePode = new Map<string, boolean>();
  const podeDevolverSc = (pi: string, dep: string) => {
    const ck = `${pi}|${dep}|${versaoSc}`;
    let v = cachePode.get(ck);
    if (v === undefined) {
      if (cachePode.size > 20000) cachePode.clear();
      v = !!ctx.cxpDe(pi) && (pulmoesDoPi(pi, dep).some((k) => roomSc(pi, k) > 0) || temVaziaSc(dep));
      cachePode.set(ck, v);
    }
    return v;
  };

  // ---- 2) quem ainda não tem casa: LOC livre de menor custo; senão, zona de baixo giro
  const evictavel = (k: string) => {
    for (const [r, it] of sim.get(k)!) {
      if (it.bloq > EPS || protegido(r)) return false;
      if (!ehAtivo.has(r) && !podeDevolverSc(r, locDe(k).dep)) return false;
    }
    return true;
  };
  const semCasa = ativos.filter((pi) => !casaDe.has(pi) && !zonaPre.has(pi));
  const naZona: string[] = [...zonaPre.keys()].sort();
  for (const pi of semCasa) {
    const cand = primLocs().filter((k) => noPaiol(pi, k) && !casaLoc.has(k) && evictavel(k)).map((k) => {
      const m = sim.get(k)!;
      let un = 0; for (const it of m.values()) un += it.qtd;
      return { k, vazia: m.size === 0 ? 0 : 1, n: m.size, un };
    }).sort((a, b) => a.vazia - b.vazia || a.n - b.n || a.un - b.un || (a.k < b.k ? -1 : 1));
    if (cand.length) { casaLoc.set(cand[0].k, pi); casaDe.set(pi, cand[0].k); } else naZona.push(pi);
  }
  // 2b) falta de LOC: quem tem MENOS saída cede a LOC para quem tem MAIS saída e vai para a zona de baixo giro.
  //     Com folga (50% + 2 pedidos) para o plano não oscilar por pequenas variações; não mexe em LOC que é destino de missão em andamento.
  const comMissao = new Set<string>();
  for (const m of efet) comMissao.add(chaveLoc(m.para));
  const maisSaida = (x: string, y: string) => ctx.dem.get(x)!.n12 > ctx.dem.get(y)!.n12 * 1.5 + 2;
  const trocarNoPaiol = (dep: string) => {
  const faltantes = ativos.filter((pi) => !casaDe.has(pi) && paiolDe.get(pi) === dep);
  const donos = ativos.filter((pi) => casaDe.has(pi) && paiolDe.get(pi) === dep).reverse(); // do menor giro para o maior
  const evictavelSem = (k: string, dono: string) => {
    for (const [r, it] of sim.get(k)!) {
      if (r === dono) { if (it.bloq > EPS) return false; continue; }
      if (it.bloq > EPS || protegido(r)) return false;
      if (!ehAtivo.has(r) && !podeDevolverSc(r, locDe(k).dep)) return false;
    }
    return true;
  };
  let iF = 0, iD = 0;
  while (iF < faltantes.length && iD < donos.length) {
    const x = faltantes[iF], y = donos[iD];
    if (!maisSaida(x, y)) break; // o dono de menor giro já não é "bem menor" que o melhor faltante
    const k = casaDe.get(y)!;
    if (comMissao.has(k) || !evictavelSem(k, y)) { iD++; continue; }
    casaDe.delete(y); casaLoc.set(k, x); casaDe.set(x, k); zonaPre.delete(x);
    iF++; iD++;
  }
  };
  for (const dep of [...depsSim].sort()) trocarNoPaiol(dep);
  // 2c) falta de LOC no paiol: 2 PIs por LOC. Os PIs de MENOR saída do paiol dividem a LOC (cada um com `caixasZona` caixas no máximo).
  //     O "hóspede" (sem casa) vai para a LOC de um "anfitrião", começando pelos anfitriões de menor saída; um anfitrião recebe um hóspede só.
  const zonaDe = new Map<string, string>(); // PI hóspede → LOC do anfitrião
  const hospedeDe = new Map<string, string>(); // LOC → PI hóspede
  const semLugar: string[] = [];
  const semLugarPis: string[] = [];
  for (const dep of [...depsSim].sort()) {
    const hospedes = ativos.filter((pi) => !casaDe.has(pi) && paiolDe.get(pi) === dep); // maior saída primeiro
    for (const pi of hospedes) { // preserva o arranjo anterior enquanto o anfitrião seguir válido
      const z = zonaPre.get(pi);
      if (z && casaLoc.has(z) && casaLoc.get(z) !== pi && !hospedeDe.has(z) && locDe(z).dep === dep) { zonaDe.set(pi, z); hospedeDe.set(z, pi); }
    }
    const anfitrioes = [...ativos].reverse().filter((pi) => casaDe.has(pi) && paiolDe.get(pi) === dep && !hospedeDe.has(casaDe.get(pi)!));
    let h = 0;
    for (const pi of hospedes) {
      if (zonaDe.has(pi)) continue;
      while (h < anfitrioes.length && hospedeDe.has(casaDe.get(anfitrioes[h])!)) h++;
      if (h >= anfitrioes.length) { semLugar.push(nome(pi)); semLugarPis.push(pi); continue; }
      const k = casaDe.get(anfitrioes[h++])!;
      zonaDe.set(pi, k); hospedeDe.set(k, pi);
    }
  }
  for (const pi of ativos) if (!casaDe.has(pi) && !zonaDe.has(pi) && !semLugarPis.includes(pi)) { semLugar.push(nome(pi)); semLugarPis.push(pi); }
  const compart = new Set(hospedeDe.keys()); // LOCs com 2 PIs

  // ---- 3) movimentações FR→FR e FR→SC
  let propostas: Proposta[] = [];
  const semDestinoSc: string[] = [], bloqueios: string[] = [];
  const baseDe = (pi: string, k: string) => ctx.livreLoc.get(`${pi}|${k}`) ?? 0;
  const novaProposta = (tipo: TipoMissao, pi: string, de: Local, para: Local, qtd: number, prioridade: 1 | 2 | 3, motivo: string, extra: Partial<Proposta> = {}): Proposta => ({
    tipo, prioridade, onda: 1, pi, desc: ctx.produtoDesc(pi), qtd, caixas: extra.caixas ?? null, de, para, lote: extra.lote ?? "", validade: extra.validade ?? "",
    idQuant: extra.idQuant ?? "", sub: extra.sub, motivo, chave: extra.chave ?? "", baseOrigem: baseDe(pi, chaveLoc(de)), baseDestino: baseDe(pi, chaveLoc(para)),
    baseEm: ctx.estoqueEm, nota: "", freq: ctx.dem.get(pi)?.freqTexto ?? "", qtdMediaPedido: Math.round((ctx.dem.get(pi)?.qtdMediaPedido ?? 0) * 10) / 10,
  });
  const limFr = (pi: string, k: string): number => {
    const lim = ctx.limites(pi);
    if (!lim) return Infinity;
    return compart.has(k) ? Math.min(lim.maxUn, params.caixasZona * lim.cxp) : lim.maxUn;
  };

  const semCxp: string[] = [], soltas: string[] = [];
  const falhasSc: { pi: string; k: string; caixas: number; motivo: string; prioridade: 1 | 2 | 3; total: number }[] = []; // devoluções sem LOC de altura 02 com espaço (tentamos consolidar e de novo)
  /** FR → SC: SEMPRE em caixas fechadas (múltiplo da CXP). O que sobra solto (menos de 1 caixa) não volta. Devolve true se criou a missão. */
  const devolver = (pi: string, k: string, qtd: number, motivo: string, prioridade: 1 | 2 | 3): boolean => {
    const cxp = ctx.cxpDe(pi);
    const loc = k.replace("|", " ");
    if (!cxp) { semCxp.push(`${nome(pi)} (${fmt(qtd)} un em ${loc})`); return false; }
    const disponivel = sim.get(k)?.get(pi)?.qtd ?? 0;
    const caixas = Math.floor(Math.min(qtd, disponivel) / cxp + EPS);
    if (caixas <= 0) { soltas.push(`${nome(pi)} (${fmt(Math.min(qtd, disponivel))} un soltas, menos de 1 caixa de ${fmt(cxp)}, em ${loc})`); return false; }
    const alocs = alocarSc(pi, locDe(k).dep, k, caixas);
    const alocadas = alocs.reduce((t, x) => t + x.cx, 0);
    if (alocadas < caixas) falhasSc.push({ pi, k, caixas: caixas - alocadas, motivo, prioridade, total: caixas });
    for (const { k: sc, cx } of alocs) {
      const q = cx * cxp;
      propostas.push(novaProposta("movimentacao", pi, locDe(k), locDe(sc), q, prioridade, motivo + (alocs.length > 1 ? ` (parte: ${cx} cx para ${locDe(sc).end}, LOC SC com limite de ${maxSc(pi)} cx)` : ""), { chave: `A|${pi}|${k}|SC:${sc}`, caixas: cx }));
      sairSim(sim, k, pi, q);
    }
    return alocs.length > 0;
  };

  // ---- 3a) SC: 1 PI por LOC ao final (mistura só provisória), altura 02 = reposição, alturas 03+ = palete fechado. As LOCs vazias são o coringa.
  const semSolucaoSc: string[] = [];
  const depsOrd = [...depsSim].sort();
  const moverSc = (sub: "descer" | "desmisturar" | "consolidar", pi: string, de: string, para: string, qtd: number, motivo: string, prioridade: 1 | 2 | 3, idQuant = "") => {
    const cxp = ctx.cxpDe(pi);
    propostas.push(novaProposta("movimentacao", pi, locDe(de), locDe(para), qtd, prioridade, motivo, { chave: `S|${sub}|${pi}|${de}|${para}|${idQuant}`, caixas: cxp ? Math.round((qtd / cxp) * 100) / 100 : undefined, sub, idQuant }));
    scSub(de, pi, qtd); scAdd(para, pi, qtd);
    for (const [id, kk] of locDaLinha) { const l = linhaSc.get(id); if (l && l.pi === pi && kk === de && (!idQuant || idQuant === id)) locDaLinha.set(id, para); }
  };
  // desmisturar: fica o PI de maior saldo; os outros vão para LOC vazia (ou, se for caixa de reposição, para a LOC de reposição do próprio PI)
  for (const dep of depsOrd) {
    const mistas = [...scSim.keys()].filter((k) => locDe(k).dep === dep && scPis(k).length >= 2).sort((a, b) => (rotaMemo(a) < rotaMemo(b) ? -1 : 1));
    for (const k of mistas) {
      const pis = scPis(k).sort((a, b) => scSim.get(k)!.get(b)!.qtd - scSim.get(k)!.get(a)!.qtd || (a < b ? -1 : 1));
      for (const pi of pis.slice(1)) {
        const it = scSim.get(k)?.get(pi);
        if (!it || it.livre <= EPS && it.qtd <= EPS) continue;
        if (it.qtd - it.livre > EPS) { semSolucaoSc.push(`${nome(pi)} em ${k.replace("|", " ")}: saldo bloqueado impede tirar o PI da LOC de SC com mais de um PI`); continue; }
        const nv = nivelDe(k), rua = ruaDeLoc(k), cxp = ctx.cxpDe(pi);
        let dest: string | undefined;
        if (nv === NIVEL_SC_REPOSICAO) dest = pulmoesDoPi(pi, dep).find((x) => x !== k && !!cxp && roomSc(pi, x) >= Math.ceil(it.qtd / cxp - EPS)) ?? vaziasSc(dep, NIVEL_SC_REPOSICAO, rua)[0];
        else dest = vaziasSc(dep, nv, rua)[0] ?? vaziasSc(dep, undefined, rua).find((x) => nivelDe(x) > NIVEL_SC_REPOSICAO) ?? vaziasSc(dep, NIVEL_SC_REPOSICAO, rua)[0];
        if (!dest) { semSolucaoSc.push(`${nome(pi)} em ${k.replace("|", " ")}: sem LOC de SC vazia no ${dep} para tirar o PI da LOC com mais de um PI`); continue; }
        moverSc("desmisturar", pi, k, dest, it.livre, `Desmisturar o SC: a LOC ${locDe(k).end} tem mais de um PI (1 PI por LOC); levar este PI para ${locDe(dest).end}`, 3);
      }
    }
  }
  // consolidar as caixas de reposição (altura 02) de um mesmo PI quando cabem numa LOC só: libera LOC vazia
  const consolidarSc = (deps: Iterable<string>) => {
    for (const dep of deps) {
      const porPi = new Map<string, string[]>();
      for (const k of scSim.keys()) {
        if (locDe(k).dep !== dep || nivelDe(k) !== NIVEL_SC_REPOSICAO) continue;
        const pis = scPis(k);
        if (pis.length === 1) (porPi.get(pis[0]) ?? porPi.set(pis[0], []).get(pis[0])!).push(k);
      }
      for (const [pi, ks] of [...porPi.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (ks.length < 2 || !ctx.cxpDe(pi)) continue;
        const ordem = ks.sort((a, b) => scBoxes(a) - scBoxes(b) || (a < b ? -1 : 1));
        for (const k of ordem) {
          const it = scSim.get(k)?.get(pi);
          if (!it || it.qtd - it.livre > EPS) continue;
          const caixas = scBoxes(k);
          const alvo = ordem.filter((x) => x !== k && scPis(x).length === 1 && scPis(x)[0] === pi).sort((a, b) => scBoxes(b) - scBoxes(a) || (a < b ? -1 : 1)).find((x) => roomSc(pi, x) >= Math.ceil(caixas - EPS));
          if (alvo) moverSc("consolidar", pi, k, alvo, it.livre, `Consolidar o SC: juntar as ${fmt(caixas)} cx do PI da LOC ${locDe(k).end} na ${locDe(alvo).end} (libera uma LOC)`, 3);
        }
      }
    }
  };

  for (const k of todasLocs()) {
    const itens = [...sim.get(k)!.keys()].sort();
    for (const pi of itens) {
      const it = sim.get(k)?.get(pi);
      if (!it || protegido(pi)) continue;
      const alvo = casaDe.get(pi) ?? zonaDe.get(pi) ?? null;
      if (alvo === k) continue;
      const movivel = it.qtd - it.bloq;
      if (!alvo) {
        // PI sem lugar definido (inativo ou sem LOC): só sai se estiver atrapalhando a casa de outro PI
        if (!casaLoc.has(k)) continue;
        if (movivel <= EPS) { bloqueios.push(`${nome(pi)} na LOC ${k.replace("|", " ")}`); continue; }
        devolver(pi, k, movivel, ehAtivo.has(pi)
          ? `Sem LOC disponível no FR para este PI (baixa saída): liberar a LOC ${locDe(k).end}, casa do PI ${casaLoc.get(k)}, devolvendo ao SC`
          : `Tirar do FR: a LOC ${locDe(k).end} é a casa do PI ${casaLoc.get(k)} e este PI não tem pedido fracionado`, 2);
        continue;
      }
      if (movivel <= EPS) { bloqueios.push(`${nome(pi)} na LOC ${k.replace("|", " ")}`); continue; }
      if (locDe(k).dep !== locDe(alvo).dep) {
        // fora do paiol do PI (o de maior saldo): não atravessa paiol, volta em caixas fechadas para o SC do próprio paiol
        devolver(pi, k, movivel, `Fora do paiol ${locDe(alvo).dep} do PI (maior saldo): devolver ao SC do ${locDe(k).dep}`, 3);
        continue;
      }
      const room = Math.max(0, limFr(pi, alvo) - qtdSim(sim, alvo, pi));
      let q = Math.min(movivel, room);
      // o que não cabe na casa: caixas inteiras voltam ao SC; a sobra solta (menos de 1 caixa) vai junto para a casa
      const resto = movivel - q;
      const cxp = ctx.cxpDe(pi) ?? 0;
      if (resto > EPS && cxp) {
        const cx = Math.floor(resto / cxp + EPS);
        if (cx > 0) devolver(pi, k, cx * cxp, `Excedente além do máximo da LOC ${locDe(alvo).end}: devolver ${cx} caixa(s) ao SC`, 3);
        const soltaFinal = Math.max(0, (sim.get(k)?.get(pi)?.qtd ?? 0) - (it.bloq ?? 0) - q);
        // menos de 1 caixa: segue para a casa; se a casa passar do máximo em caixas inteiras, ela devolve uma caixa fechada ao SC
        if (soltaFinal > EPS && soltaFinal < cxp - EPS) q += soltaFinal;
        else if (soltaFinal >= cxp - EPS) soltas.push(`${nome(pi)} (${fmt(soltaFinal)} un em ${k.replace("|", " ")} sem destino no SC)`);
      } else if (resto > EPS) semCxp.push(`${nome(pi)} (${fmt(resto)} un em ${k.replace("|", " ")})`);
      if (q > EPS) {
        propostas.push(novaProposta("movimentacao", pi, locDe(k), locDe(alvo), q, 2,
          !compart.has(alvo) ? `Juntar o PI na sua LOC ${locDe(alvo).end} (1 PI por LOC)` : `Faltam LOCs no ${locDe(alvo).dep}: este PI de baixa saída divide a LOC ${locDe(alvo).end} com outro (2 PIs por LOC, até ${params.caixasZona} caixas cada)`,
          { chave: `A|${pi}|${k}|${alvo}` }));
        sairSim(sim, k, pi, q); entrarSim(sim, alvo, pi, q);
      }
    }
  }
  // excedente nas casas/zona: o máximo vale em CAIXAS INTEIRAS (unidades soltas, menos de 1 caixa, são uma caixa aberta e não contam)
  for (const pi of [...ativos]) {
    const alvo = casaDe.get(pi) ?? zonaDe.get(pi);
    if (!alvo) continue;
    const lim = ctx.limites(pi)!;
    const maxCx = Math.floor(limFr(pi, alvo) / lim.cxp + EPS);
    const q = qtdSim(sim, alvo, pi);
    const inteiras = Math.floor(q / lim.cxp + EPS);
    if (inteiras > maxCx) {
      const it = sim.get(alvo)!.get(pi)!;
      const movivel = Math.min(it.qtd - it.bloq, Math.max(0, q - lim.minUn));
      const dev = Math.min(inteiras - maxCx, Math.floor(movivel / lim.cxp + EPS));
      if (dev > 0) devolver(pi, alvo, dev * lim.cxp, `Acima do máximo de ${maxCx} caixa(s) na LOC ${locDe(alvo).end}: devolver ${dev} caixa(s) ao SC`, 3);
    }
  }

  // devolução sem LOC de altura 02 com espaço: consolidar as caixas de reposição do paiol para abrir espaço e tentar de novo
  if (falhasSc.length) {
    const lista = falhasSc.splice(0);
    consolidarSc(new Set(lista.map((f) => locDe(f.k).dep)));
    for (const f of lista) { const cxp = ctx.cxpDe(f.pi); if (cxp) devolver(f.pi, f.k, f.caixas * cxp, f.motivo, f.prioridade); }
  }
  for (const f of falhasSc) semDestinoSc.push(`${nome(f.pi)} (${f.caixas} de ${f.total} caixa(s) em ${f.k.replace("|", " ")}: sem LOC de SC de altura 02 com espaço — máx. ${maxSc(f.pi)} cx)`);

  // ---- 4) recompletamento: casa/zona abaixo do mínimo recebe caixas fechadas de SC
  const semOrigem: string[] = [], parcial: string[] = [];
  for (const pi of ativos) {
    const alvo = casaDe.get(pi) ?? zonaDe.get(pi);
    if (!alvo) continue;
    const lim = ctx.limites(pi)!;
    const d = ctx.dem.get(pi)!;
    const cur = qtdSim(sim, alvo, pi);
    if (cur >= lim.minUn - EPS) continue;
    const capCx = Math.floor(limFr(pi, alvo) / lim.cxp + EPS);
    const alvoCx = Math.min(capCx, Math.max(lim.minCx, Math.ceil((params.pedidosCobertura * d.qtdMediaPedido) / lim.cxp - EPS)));
    const atualCx = Math.floor(cur / lim.cxp + EPS);
    let precisa = alvoCx - atualCx;
    if (precisa <= 0) continue;
    const depAlvo = locDe(alvo).dep;
    interface Fonte { l: Linha; livre: number; k: string }
    const todas: Fonte[] = (ctx.linhasSc.get(pi) ?? [])
      .map((l) => ({ l, livre: l.disp - (pendSc.get(l.id) ?? 0), k: locDaLinha.get(l.id) ?? l.dep + "|" + l.end }))
      .filter((x) => x.livre >= lim.cxp - EPS);
    const ordem = (a: Fonte, b: Fonte) => Number(locDe(b.k).dep === depAlvo) - Number(locDe(a.k).dep === depAlvo) || (a.l.val || "9999").localeCompare(b.l.val || "9999") || a.livre - b.livre || (a.l.id < b.l.id ? -1 : 1);
    const baixas = todas.filter((x) => nivelDe(x.k) <= NIVEL_SC_REPOSICAO).sort(ordem); // LOC de reposição (altura 02): de onde se tira para o FR
    const altas = todas.filter((x) => nivelDe(x.k) > NIVEL_SC_REPOSICAO).sort(ordem); // palete fechado (03+): só desce inteiro quando a altura 02 acaba
    const inicial = precisa;
    const pegar = (f: Fonte, de: string) => {
      const take = Math.min(Math.floor(f.livre / lim.cxp + EPS), precisa);
      if (take <= 0) return;
      propostas.push(novaProposta("recompletamento", pi, locDe(de), locDe(alvo), take * lim.cxp, cur <= EPS ? 1 : 2,
        `FR com ${fmt(cur)} un (mínimo ${lim.minCx} caixa(s) de ${fmt(lim.cxp)}); repor até ${alvoCx} caixa(s) = ${params.pedidosCobertura} pedido(s) fracionado(s) médio(s) de ${fmt(d.qtdMediaPedido)} un`,
        { caixas: take, lote: f.l.lote, validade: f.l.val, idQuant: f.l.id, chave: `R|${pi}|${f.l.id}|${alvo}` }));
      pendSc.set(f.l.id, (pendSc.get(f.l.id) ?? 0) + take * lim.cxp);
      scSub(de, pi, take * lim.cxp);
      entrarSim(sim, alvo, pi, take * lim.cxp);
      precisa -= take;
    };
    for (const f of baixas) { if (precisa <= 0) break; pegar(f, f.k); }
    for (const f of altas) {
      if (precisa <= 0) break;
      // acabou a altura 02: desce o palete inteiro (a LOC de altura 02 vazia do paiol, a mais próxima) e repõe dela; sem LOC vazia, repõe direto do palete
      const inteira = f.livre >= f.l.disp - EPS && (pendSc.get(f.l.id) ?? 0) === 0;
      const dest = locDe(f.k).dep === depAlvo && inteira ? vaziasSc(depAlvo, NIVEL_SC_REPOSICAO, ruaDeLoc(f.k))[0] : undefined;
      if (dest) { moverSc("descer", pi, f.k, dest, f.l.disp, `Descer o palete da altura ${String(nivelDe(f.k)).padStart(2, "0")} para a altura 02 (${locDe(dest).end}): a reposição do FR acabou a LOC de altura 02`, 2, f.l.id); pegar(f, dest); }
      else pegar(f, f.k);
    }
    if (precisa > 0) {
      const e = ctx.est.get(pi);
      const txt = nome(pi);
      if (precisa === inicial) { if ((e?.bloq ?? 0) > 0 || (e?.sc ?? 0) > 0) semOrigem.push(txt); } else parcial.push(`${txt} (faltam ${precisa} caixa(s))`);
    }
  }

  // ---- 5) ondas: a AUDITORIA decide a ordem. Tudo começa na onda 1; quem fere um limite (destino acima do máximo, outro PI na LOC, origem sem saldo)
  //         vai para a onda seguinte, até a ordem fechar. O que nenhuma ordem conserta é descartado (nunca sai missão que a auditoria reprova).
  const saidas = new Map<string, Set<string>>(); // LOC → PIs que saem dela por missão
  for (const p of propostas) if (p.tipo === "movimentacao") (saidas.get(chaveLoc(p.de)) ?? saidas.set(chaveLoc(p.de), new Set()).get(chaveLoc(p.de))!).add(p.pi);
  for (const p of propostas) {
    const dest = chaveLoc(p.para);
    const estranhos = [...(ctx.ocupFr.get(dest) ?? [])].filter((x) => x !== p.pi && (saidas.get(dest)?.has(x) ?? false));
    if (!estranhos.length) continue;
    // troca de LOCs (A→B e B→A): não dá para ordenar, executar juntas
    const troca = propostas.find((q) => q !== p && chaveLoc(q.de) === dest && chaveLoc(q.para) === chaveLoc(p.de));
    if (troca) { p.nota = troca.nota = "Troca entre duas LOCs: executar as duas missões juntas"; }
  }
  const comoMissoes = (lista: Proposta[]): Missao[] => lista.map((p, i) => ({ ...p, id: `~${String(i).padStart(5, "0")}`, origem: "auto", status: "pendente", responsavel: "", obs: "", criadaEm: "", atualizadoEm: "", concluidaEm: null, verificadaEm: null, motivoCancelamento: "" }) as Missao);
  const locsFrPlano = new Set([...casaDe.values(), ...zonaDe.values(), ...sim.keys()]);
  const auditarLista = (lista: Proposta[]) => auditar(ctx, [...efet, ...comoMissoes(lista)], compart, locsFrPlano);
  const bumpaveis = new Set(["FR-LIMITE", "FR-1PI", "ORIGEM"]);
  for (let volta = 0; volta < 8; volta++) {
    const ruins = new Set(auditarLista(propostas).violacoes.filter((v) => v.id.startsWith("~") && bumpaveis.has(v.regra)).map((v) => v.id));
    if (!ruins.size) break;
    let mexeu = false;
    for (const id of ruins) { const p = propostas[Number(id.slice(1))]; if (p.onda < 4) { p.onda++; mexeu = true; } }
    if (!mexeu) break;
  }
  const descartadas: string[] = [];
  {
    const r = auditarLista(propostas);
    const ruins = new Map<string, string>();
    for (const v of r.violacoes) if (v.id.startsWith("~") && !ruins.has(v.id)) ruins.set(v.id, `${v.regra}: ${v.detalhe}`);
    if (ruins.size) {
      for (const [id, det] of ruins) { const p = propostas[Number(id.slice(1))]; descartadas.push(`${p.pi} ${p.de.dep} ${p.de.end} → ${p.para.end} (${fmt(p.qtd)} un) — ${det}`); }
      propostas = propostas.filter((_, i) => !ruins.has(`~${String(i).padStart(5, "0")}`));
    }
  }

  const alertas: Alerta[] = [];
  const mk = (id: string, nivel: Alerta["nivel"], regra: string, titulo: string, detalhe: string, lista: string[], tipo: TipoMissao) => {
    if (lista.length) alertas.push({ id, nivel, regra, titulo, detalhe, tipo, total: lista.length, exemplos: lista.slice(0, 8) });
  };
  mk("rc-sem-origem", "critico", "Recompletamento precisa de caixas fechadas em SC", "FR abaixo do mínimo sem caixa fechada livre em SC", "Não há caixa fechada livre em SC para repor (o saldo pode estar bloqueado ou fracionado).", semOrigem, "recompletamento");
  mk("rc-parcial", "atencao", "Recompletamento cobre a meta", "SC não cobre toda a reposição necessária", "Há caixas em SC, mas não o bastante para atingir a meta.", parcial, "recompletamento");
  mk("mv-sem-destino-sc", "atencao", "Excedente volta para o SC", "Sem espaço em LOC SC para devolver o excedente", "As LOCs SC do PI neste paiol estão cheias (limite de caixas por LOC) ou o PI não tem LOC SC nele, e não há LOC SC vazia no mesmo paiol. A devolução não atravessa paiol.", semDestinoSc, "movimentacao");
  mk("mv-sem-cxp", "atencao", "FR → SC em caixas fechadas", "Sem caixa padrão (CXP) para devolver ao SC", "A devolução ao SC só é feita em caixas fechadas, e este PI não tem CXP conhecida (nenhum pedido na planilha de pedidos).", semCxp, "movimentacao");
  mk("mv-soltas", "info", "FR → SC em caixas fechadas", "Sobra solta (menos de 1 caixa) não volta ao SC", "Só caixas fechadas voltam ao SC; unidades soltas menores que 1 caixa permanecem na LOC.", soltas, "movimentacao");
  mk("mv-bloqueio", "atencao", "1 PI por LOC", "Saldo bloqueado impede esvaziar a LOC", "O PI tem saldo bloqueado nesta LOC: resolva o bloqueio antes de movimentar.", bloqueios, "movimentacao");
  mk("sc-sem-solucao", "atencao", "SC: 1 PI por LOC", "LOC de SC com mais de um PI sem como desmisturar", "Falta LOC de SC vazia no paiol (ou há saldo bloqueado) para tirar o PI extra. A mistura só vale como provisória.", semSolucaoSc, "movimentacao");
  mk("auditoria-descartada", "atencao", "Auditoria do plano", "Missão reprovada pela auditoria e descartada", "A missão feriria um limite (caixas fechadas, máximo de caixas no SC ou no FR, 1 PI por LOC, origem sem saldo ou outro paiol) em qualquer ordem e não foi criada. Normalmente falta LOC vazia no paiol.", descartadas, "movimentacao");
  mk("mv-sem-lugar", "critico", "Todo PI fracionado precisa de uma LOC",
    `Faltou LOC no paiol, mesmo com 2 PIs por LOC: ${semLugar.length} PI(s) sem lugar`,
    `Há ${ativos.length} PIs com fracionado, ${casaDe.size} com LOC própria e ${zonaDe.size} dividindo LOC (2 por LOC). Faltam LOCs para ${semLugar.length} PIs (os de menor saída do paiol); o saldo deles no FR é devolvido ao SC. Para mantê-los no FR, libere LOCs FR vazias no paiol (consulta de endereços vazios ou Parâmetros).`,
    semLugar, "movimentacao");

  propostas.sort((a, b) => a.onda - b.onda || a.prioridade - b.prioridade || (a.chave < b.chave ? -1 : 1));
  return {
    propostas, alertas, casas: Object.fromEntries([...casaDe.entries()].sort()), zona: Object.fromEntries([...zonaDe.entries()].sort()),
    resumo: { ativos: ativos.length, comCasa: casaDe.size, naZona: zonaDe.size, semLugar: semLugar.length, semLugarPis },
  };
}

/* ------------------------------------------------------------------ verificação */

export interface Verificacao {
  estado: "concluida" | "parcial" | "pendente" | "divergente" | "obsoleta";
  semChegada?: boolean; // divergente porque a origem sumiu e NADA apareceu no destino (item removido/migrado, não movimentado)
  restante?: number;
  nota: string;
}

/**
 * Compara as missões em andamento com a planilha de estoque atual.
 * Várias missões podem sair da mesma LOC ou chegar à mesma LOC (juntar PIs, devolver excedente),
 * então a saída e a chegada são alocadas POR GRUPO (PI + LOC), na ordem das missões.
 */
export function verificarMissoes(ms: Missao[], ctx: Contexto): Map<string, Verificacao> {
  const out = new Map<string, Verificacao>();
  const tol = 1e-6;
  const ordenadas = [...ms].sort((a, b) => (a.id < b.id ? -1 : 1));
  const livre = (pi: string, l: Local) => ctx.livreLoc.get(`${pi}|${chaveLoc(l)}`) ?? 0;
  // pontas "misturadas": a LOC recebe (ou envia) o mesmo PI por outra missão, então a variação líquida não prova nada sozinha
  const recebe = new Set(ordenadas.map((m) => `${m.pi}|${chaveLoc(m.para)}`));
  const envia = new Set(ordenadas.filter((m) => m.tipo === "movimentacao").map((m) => `${m.pi}|${chaveLoc(m.de)}`));

  // 1) saída da origem (só movimentação; no recompletamento a paleta de SC pode ser outra). Sem prova se a origem também recebe.
  const porOrigem = new Map<string, Missao[]>();
  for (const m of ordenadas) if (m.tipo === "movimentacao") (porOrigem.get(`${m.pi}|${chaveLoc(m.de)}`) ?? porOrigem.set(`${m.pi}|${chaveLoc(m.de)}`, []).get(`${m.pi}|${chaveLoc(m.de)}`)!).push(m);
  const origDone = new Map<string, boolean>(), origParcial = new Map<string, number>();
  for (const [k, g] of porOrigem) {
    if (recebe.has(k)) continue; // origem misturada: a prova vem do destino
    let disp = Math.max(0, Math.max(...g.map((m) => m.baseOrigem ?? 0)) - livre(g[0].pi, g[0].de));
    for (const m of g) {
      if (disp >= m.qtd - tol) { origDone.set(m.id, true); disp -= m.qtd; }
      else { if (disp > tol) origParcial.set(m.id, disp); disp = 0; }
    }
  }
  const origemComProva = (m: Missao) => m.tipo === "movimentacao" && !recebe.has(`${m.pi}|${chaveLoc(m.de)}`);

  // 2) chegada ao destino (sem prova se o destino também envia o mesmo PI)
  const porDestino = new Map<string, Missao[]>();
  for (const m of ordenadas) (porDestino.get(`${m.pi}|${chaveLoc(m.para)}`) ?? porDestino.set(`${m.pi}|${chaveLoc(m.para)}`, []).get(`${m.pi}|${chaveLoc(m.para)}`)!).push(m);
  for (const [k, g] of porDestino) {
    const destinoComProva = !envia.has(k);
    // destino misturado: confia na saída da origem (quando há prova)
    if (!destinoComProva) {
      for (const m of g) if (origDone.get(m.id)) out.set(m.id, { estado: "concluida", nota: "Confirmada pela saída da origem (o destino também enviou o mesmo PI, então a chegada não se isola)." });
      continue;
    }
    let chegou = Math.max(0, livre(g[0].pi, g[0].para) - Math.min(...g.map((m) => m.baseDestino ?? 0)));
    for (const m of g.filter((x) => x.tipo === "movimentacao" && origDone.get(x.id))) {
      if (chegou >= m.qtd - tol) { out.set(m.id, { estado: "concluida", nota: "Confirmada pela planilha: saiu da origem e chegou ao destino." }); chegou -= m.qtd; }
      else if (chegou > tol) { out.set(m.id, { estado: "divergente", nota: `Saiu da origem, mas só ${fmt(chegou)} de ${fmt(m.qtd)} un apareceram no destino.` }); chegou = 0; }
      else out.set(m.id, { estado: "divergente", semChegada: true, nota: "Saiu da origem mas não apareceu no destino: confira o endereço ou se o item foi perdido." });
    }
    for (const m of g.filter((x) => x.tipo === "recompletamento" || (x.tipo === "movimentacao" && !origemComProva(x)))) {
      if (chegou >= m.qtd - tol) { out.set(m.id, { estado: "concluida", nota: m.tipo === "recompletamento" ? "Confirmada: o FR recebeu a quantidade (a paleta de SC pode ter sido outra)." : "Confirmada pela chegada ao destino." }); chegou -= m.qtd; }
      else if (chegou > tol) { out.set(m.id, { estado: "parcial", restante: m.qtd - chegou, nota: `Parcial: chegaram ${fmt(chegou)} un; faltam ${fmt(m.qtd - chegou)}.` }); chegou = 0; }
    }
    for (const m of g.filter((x) => x.tipo === "movimentacao" && origemComProva(x) && !origDone.get(x.id))) {
      const parc = origParcial.get(m.id) ?? 0;
      if (parc > tol) out.set(m.id, { estado: "parcial", restante: m.qtd - parc, nota: `Parcial: saíram ${fmt(parc)} un da origem; faltam ${fmt(m.qtd - parc)}.` });
    }
  }
  // 3) sem nenhuma evidência
  for (const m of ordenadas) {
    if (out.has(m.id)) continue;
    const aguardaChegada = m.tipo === "movimentacao" && recebe.has(`${m.pi}|${chaveLoc(m.de)}`); // a origem recebe o PI de outra missão: ainda pode não ter saldo
    const orig = livre(m.pi, m.de);
    if (!aguardaChegada && m.tipo === "movimentacao" && orig < m.qtd - tol) out.set(m.id, { estado: "obsoleta", nota: "Origem sem saldo livre suficiente (mudou por outro motivo)." });
    else if (m.tipo === "recompletamento" && (ctx.livrePorId.get(m.idQuant) ?? 0) < m.qtd - tol && !ctx.linhasSc.get(m.pi)?.some((l) => l.disp >= m.qtd - tol)) out.set(m.id, { estado: "obsoleta", nota: "Não há mais caixas fechadas livres em SC para esta missão." });
    else out.set(m.id, { estado: "pendente", nota: "" });
  }
  return out;
}

/* ------------------------------------------------------------ sincronização */

/** 1º passo: confere as missões em andamento contra a planilha nova (concluída, parcial, divergente, obsoleta). */
export function verificarEstado(estado: EstadoMissoes, ctx: Contexto, agora: string): boolean {
  let mudou = false;

  // 0) PI que não existe mais na planilha de estoque (removido ou migrado para outro código): missão automática aberta perde o sentido
  for (const m of Object.values(estado.missoes)) {
    if (m.origem === "auto" && EM_ANDAMENTO(m.status) && !ctx.dados.produtos[m.pi]) {
      m.status = "cancelada"; m.motivoCancelamento = "Automático: o PI não existe mais na planilha de estoque (removido ou migrado para outro código)."; m.atualizadoEm = agora; mudou = true;
    }
  }

  // 1) verificação: só das missões cuja "foto" é anterior à planilha atual
  const paraVerificar = Object.values(estado.missoes).filter((m) => EM_ANDAMENTO(m.status) && ctx.estoqueEm > (m.baseEm ?? ""));
  const res = verificarMissoes(paraVerificar, ctx);
  for (const m of paraVerificar) {
    const v = res.get(m.id)!;
    if (v.estado === "concluida") { m.status = "concluida"; m.verificadaEm = agora; m.concluidaEm = m.concluidaEm ?? agora; m.nota = v.nota; m.atualizadoEm = agora; mudou = true; continue; }
    // automática que ninguém iniciou, cuja origem sumiu da planilha sem nada chegar ao destino: o item foi removido/migrado, não movimentado
    if (v.estado === "divergente" && v.semChegada && m.origem === "auto" && m.status === "pendente") { m.status = "cancelada"; m.motivoCancelamento = "Automático: a origem sumiu da planilha e nada chegou ao destino (item removido ou migrado)."; m.atualizadoEm = agora; mudou = true; continue; }
    if (v.estado === "divergente") { m.status = "divergente"; m.nota = v.nota; m.atualizadoEm = agora; mudou = true; }
    else if (v.estado === "parcial") {
      m.qtd = Math.max(0, v.restante ?? m.qtd);
      const lim = ctx.limites(m.pi);
      if (m.caixas !== null && lim) m.caixas = Math.round((m.qtd / lim.cxp) * 100) / 100;
      m.nota = v.nota; m.atualizadoEm = agora; mudou = true;
    } else if (v.estado === "obsoleta" && m.origem === "auto" && m.status === "pendente") { m.status = "cancelada"; m.motivoCancelamento = `Automático: ${v.nota}`; m.atualizadoEm = agora; mudou = true; continue; }
    else if (v.estado === "pendente" && m.status === "feita" && m.concluidaEm && ctx.estoqueEm > m.concluidaEm) {
      m.status = "divergente"; m.nota = "Marcada como feita, mas a planilha de estoque (posterior) não mostra o resultado."; m.atualizadoEm = agora; mudou = true;
    } else if (v.nota && v.nota !== m.nota) { m.nota = v.nota; mudou = true; }
    // a "foto" passa a ser a planilha atual: a próxima conferência mede só o que mudar daqui para frente
    m.baseOrigem = ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.de)}`) ?? 0;
    m.baseDestino = ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.para)}`) ?? 0;
    m.baseEm = ctx.estoqueEm;
    mudou = true;
  }

  // 3) auditoria: missão automática pendente que fere um limite (caixas fechadas, máximo de caixas, outro paiol) é cancelada e refeita no próximo plano
  const emAndamento = Object.values(estado.missoes).filter((m) => EM_ANDAMENTO(m.status));
  const aud = auditar(ctx, emAndamento, new Set(Object.values(estado.zona ?? {})), new Set([...Object.values(estado.casas ?? {}), ...Object.values(estado.zona ?? {})]));
  const motivos = new Map<string, string>();
  for (const v of aud.violacoes) if (["SC-LIMITE", "SC-NIVEL", "SC-VAZIA", "CX-FECHADA", "PAIOL", "FR-LIMITE"].includes(v.regra) && !motivos.has(v.id)) motivos.set(v.id, `${v.regra}: ${v.detalhe}`);
  for (const [id, motivo] of motivos) {
    const m = estado.missoes[id];
    if (m && m.origem === "auto" && m.status === "pendente") { m.status = "cancelada"; m.motivoCancelamento = `Auditoria: ${motivo}`; m.atualizadoEm = agora; mudou = true; }
  }

  return mudou;
}

/** 2º passo (depois do plano, que já considera só o que segue em andamento): cria as missões novas e poda o histórico. */
export function criarMissoes(estado: EstadoMissoes, plano: Plano | null, agora: string): boolean {
  let mudou = false;
  // missões novas
  if (plano) {
    const existentes = new Set(Object.values(estado.missoes).filter((m) => EM_ANDAMENTO(m.status)).map((m) => m.chave).filter(Boolean));
    for (const p of plano.propostas) {
      if (existentes.has(p.chave)) continue;
      const letra = p.tipo === "recompletamento" ? "R" : "A";
      const id = `${letra}-${String(++estado.seq[letra]).padStart(6, "0")}`;
      estado.missoes[id] = { ...p, id, origem: "auto", status: "pendente", responsavel: "", obs: "", criadaEm: agora, atualizadoEm: agora, concluidaEm: null, verificadaEm: null, motivoCancelamento: "" };
      existentes.add(p.chave);
      mudou = true;
    }
  }

  // poda: encerradas há mais de 90 dias
  for (const m of Object.values(estado.missoes)) {
    if ((m.status === "concluida" || m.status === "cancelada") && Date.parse(agora) - Date.parse(m.atualizadoEm) > 90 * DIA) { delete estado.missoes[m.id]; mudou = true; }
  }
  return mudou;
}

/* ------------------------------------------------------------------- alertas */

export function alertasDoEstado(ctx: Contexto, missoes: Missao[], conf: Conformidade, agora: string): Alerta[] {
  const out: Alerta[] = [];
  const add = (a: Alerta) => out.push(a);
  const abertas = missoes.filter((m) => EM_ANDAMENTO(m.status));

  if (!ctx.rm)
    add({ id: "sem-rm", nivel: "atencao", regra: "Missões automáticas dependem dos pedidos", titulo: "Sem planilha de pedidos (QTD/CXP)", detalhe: "Sem a caixa padrão e o histórico de fracionados não é possível planejar. Missões manuais continuam funcionando." });
  const fora = conf.locs - conf.conformes;
  if (fora > 0)
    add({ id: "fora-do-padrao", nivel: "info", regra: "1 PI por LOC, entre o mínimo e o máximo de caixas", titulo: `${fora} de ${conf.locs} LOCs FR fora do padrão`,
      detalhe: `Hoje: ${conf.maisDeUmPi} com mais de um PI, ${conf.acimaDoMaximo} acima do máximo de caixas, ${conf.abaixoDoMinimo} abaixo do mínimo; ${conf.pisSemLoc} PIs com fracionado e sem LOC própria. As missões abertas já tratam a maior parte.`, total: fora });

  const porOrigem = new Map<string, { qtd: number; ids: string[]; livre: number }>();
  const stale: string[] = [], conflito: string[] = [], estouro: string[] = [], paradas: string[] = [], foraRegra: string[] = [], diverg: string[] = [];
  for (const m of abertas) {
    if (m.status === "divergente") diverg.push(`${m.id} · ${m.pi} ${m.de.dep} ${m.de.end} → ${m.para.dep} ${m.para.end}: ${m.nota}`);
    const livre = m.tipo === "recompletamento" && m.idQuant ? (ctx.livrePorId.get(m.idQuant) ?? 0) : (ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.de)}`) ?? 0);
    const kO = `${m.pi}|${chaveLoc(m.de)}|${m.idQuant}`;
    const po = porOrigem.get(kO) ?? { qtd: 0, ids: [], livre };
    po.qtd += m.qtd; po.ids.push(m.id); porOrigem.set(kO, po);
    const aguardaChegada = m.tipo === "movimentacao" && abertas.some((x) => x !== m && x.pi === m.pi && chaveLoc(x.para) === chaveLoc(m.de));
    if (m.status !== "divergente" && !aguardaChegada && livre < m.qtd - EPS) stale.push(`${m.id} · ${m.pi} em ${m.de.dep} ${m.de.end}: saldo livre ${fmt(livre)} < ${fmt(m.qtd)}`);
    const ocup = ctx.ocupFr.get(chaveLoc(m.para)) ?? new Set<string>();
    const outros = [...ocup].filter((p) => p !== m.pi);
    if (outros.length && !ocup.has(m.pi) && m.onda === 1 && m.origem === "manual") conflito.push(`${m.id} · destino ${m.para.dep} ${m.para.end} também tem ${outros.slice(0, 3).join(", ")}`);
    const lim = ctx.limites(m.pi);
    const emDest = ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.para)}`) ?? 0;
    if (lim && Math.floor((emDest + m.qtd) / lim.cxp + EPS) > lim.maxCx && m.para.dep && ctx.areasLoc.get(chaveLoc(m.para))?.has("FR")) estouro.push(`${m.id} · ${m.pi}: ${fmt(emDest + m.qtd)} un no destino > máximo ${fmt(lim.maxUn)}`);
    const idade = Date.parse(agora) - Date.parse(m.atualizadoEm);
    if ((m.status === "pendente" && idade > 2 * DIA) || (m.status === "em_execucao" && idade > 1 * DIA)) paradas.push(`${m.id} · ${m.status === "pendente" ? "pendente" : "em execução"} há ${Math.floor(idade / DIA)} dia(s)`);
    if (ctx.est.get(m.pi)?.noP04) foraRegra.push(`${m.id} · ${m.pi} tem saldo no P04 (fora das regras de reposição)`);
  }
  const over = [...porOrigem.values()].filter((x) => x.qtd > x.livre + EPS).map((x) => `${x.ids.join(", ")}: ${fmt(x.qtd)} un pedidas para ${fmt(x.livre)} livres`);
  const mk = (id: string, nivel: Alerta["nivel"], regra: string, titulo: string, detalhe: string, lista: string[], tipo?: TipoMissao) => {
    if (lista.length) add({ id, nivel, regra, titulo, detalhe, total: lista.length, exemplos: lista.slice(0, 8), tipo });
  };
  mk("divergente", "critico", "Missão confirmada pela planilha", "Missão divergente", "A planilha de estoque não bateu com o que a missão previa. Confira com quem executou.", diverg);
  mk("origem-sem-saldo", "critico", "A origem precisa ter o saldo da missão", "Missão aberta com origem sem saldo livre", "O saldo livre na origem é menor que a quantidade da missão (já foi movido, bloqueado ou a planilha mudou).", stale);
  mk("overbooking", "critico", "Uma origem não pode ser prometida duas vezes", "Mais de uma missão consome o mesmo estoque além do disponível", "A soma das missões sobre a mesma origem passa do saldo livre.", over);
  mk("destino-misturado", "atencao", "1 PI por LOC", "Missão manual leva o PI para uma LOC que já tem outro PI", "Executar a missão quebra a regra de 1 PI por LOC.", conflito);
  mk("destino-capacidade", "atencao", "Máximo de caixas por LOC", "Missão ultrapassa o máximo de caixas da LOC de destino", "Saldo no destino + missão passa do máximo de caixas por LOC.", estouro);
  mk("missao-parada", "atencao", "Missões devem andar", "Missão parada", "Pendente há mais de 2 dias ou em execução há mais de 1 dia sem atualização.", paradas);
  mk("fora-regra", "atencao", "PIs com saldo no P04 ficam fora", "Missão aberta de PI que tem saldo no P04", "A regra de reposição desconsidera PIs com saldo no P04.", foraRegra);
  return out;
}

/* -------------------------------------------------------- validação de manual */

export interface EntradaManual {
  tipo: TipoMissao;
  pi: string;
  qtd?: number;
  caixas?: number;
  de: Local;
  para: Local;
  prioridade?: 1 | 2 | 3;
  responsavel?: string;
  obs?: string;
}

export function validarManual(e: EntradaManual, ctx: Contexto, missoes: Missao[]): { avisos: AvisoValidacao[]; qtd: number } {
  const av: AvisoValidacao[] = [];
  const erro = (texto: string) => av.push({ nivel: "erro", texto });
  const aviso = (texto: string) => av.push({ nivel: "aviso", texto });
  const lim = ctx.limites(e.pi);
  const cxp = lim?.cxp;
  let qtd = Number(e.qtd) || 0;
  if (e.tipo === "recompletamento" && Number(e.caixas) > 0) {
    if (cxp) qtd = Number(e.caixas) * cxp; else if (!qtd) erro("Caixa padrão deste PI não conhecida: informe a quantidade em unidades.");
  }
  if (!e.pi) erro("Informe o PI.");
  else if (!ctx.dados.produtos[e.pi]) erro(`PI ${e.pi} não existe na planilha de estoque.`);
  if (!(qtd > 0)) erro("Informe uma quantidade maior que zero.");
  for (const [nomeL, l] of [["origem", e.de], ["destino", e.para]] as const) if (!l.dep || !l.end) erro(`Informe o paiol e o endereço de ${nomeL}.`);
  if (e.de.dep && e.para.dep && chaveLoc(e.de) === chaveLoc(e.para)) erro("Origem e destino são a mesma LOC.");
  if (av.some((a) => a.nivel === "erro")) return { avisos: av, qtd };

  const ef = efetivas(missoes);
  const jaPedido = ef.filter((m) => m.pi === e.pi && chaveLoc(m.de) === chaveLoc(e.de)).reduce((s, m) => s + m.qtd, 0);
  const livre = ctx.livreLoc.get(`${e.pi}|${chaveLoc(e.de)}`) ?? 0;
  if (livre <= 0) aviso(`Não há saldo livre do PI ${e.pi} em ${e.de.dep} ${e.de.end} na planilha.`);
  else if (livre - jaPedido < qtd - EPS) aviso(`Saldo livre na origem (${fmt(livre)} un, ${fmt(jaPedido)} já em outras missões) é menor que ${fmt(qtd)}.`);
  const areasDe = ctx.areasLoc.get(chaveLoc(e.de)), areasPara = ctx.areasLoc.get(chaveLoc(e.para));
  if (e.tipo === "recompletamento") {
    if (areasDe && !areasDe.has("SC")) aviso("A origem não é uma LOC de caixa fechada (SC).");
    if (areasPara && !areasPara.has("FR")) aviso("O destino não é uma LOC FR.");
    if (!areasPara && !ctx.params.locsVazias.some((v) => chaveLoc(v) === chaveLoc(e.para))) aviso("O destino não aparece na planilha com saldo nem está nas LOCs vazias informadas: confira o endereço.");
    if (cxp && Math.abs(qtd / cxp - Math.round(qtd / cxp)) > 1e-6) aviso(`A quantidade não é múltipla da caixa padrão (${fmt(cxp)}): recompletamento é de caixas fechadas.`);
  } else {
    if (areasDe && !areasDe.has("FR")) aviso("A origem não é uma LOC FR.");
    if (areasPara && !areasPara.has("FR") && !areasPara.has("SC")) aviso("O destino não é uma LOC FR nem SC.");
    if (areasPara?.has("SC") && !areasPara.has("FR") && cxp && Math.abs(qtd / cxp - Math.round(qtd / cxp)) > 1e-6) aviso(`Devolução ao SC deve ser em caixas fechadas: ${fmt(qtd)} un não é múltiplo da caixa padrão (${fmt(cxp)}).`);
    if (areasPara?.has("SC") && !areasPara.has("FR") && cxp) {
      const k = chaveLoc(e.para);
      const ocup = ctx.scCaixas(k);
      const lim = ctx.ehCalcado(e.pi) ? ctx.params.maxCaixasScCalcado : ctx.params.maxCaixasSc;
      if (!Number.isFinite(ocup)) aviso(`A LOC SC ${e.para.end} tem item sem caixa padrão (CXP) conhecida: não dá para conferir o limite de ${lim} caixas.`);
      else if (ocup + qtd / cxp > lim + EPS) aviso(`A LOC SC ${e.para.end} ficaria com ${Math.round((ocup + qtd / cxp) * 10) / 10} caixa(s), acima do limite de ${lim}.`);
    }
    if (areasPara?.has("SC") && !areasPara.has("FR") && !cxp) aviso("Caixa padrão (CXP) deste PI não conhecida: não dá para conferir se a devolução ao SC é em caixas fechadas.");
  }
  if (areasPara?.has("FR")) {
    const ocupDest = ctx.ocupFr.get(chaveLoc(e.para)) ?? new Set<string>();
    const outros = [...ocupDest].filter((p) => p !== e.pi);
    if (outros.length && !ocupDest.has(e.pi)) aviso(`O destino já tem outro PI (${outros.slice(0, 3).join(", ")}): a regra de 1 PI por LOC será quebrada.`);
    const noDest = ctx.livreLoc.get(`${e.pi}|${chaveLoc(e.para)}`) ?? 0;
    if (lim && Math.floor((noDest + qtd) / lim.cxp + EPS) > lim.maxCx) aviso(`O destino ficaria com ${fmt(noDest + qtd)} un, acima do máximo de ${lim.maxCx} caixa(s) (${fmt(lim.maxUn)} un).`);
  }
  if (ctx.est.get(e.pi)?.noP04) aviso("Este PI tem saldo no P04, que fica fora das regras de reposição.");
  return { avisos: av, qtd };
}

export { ABERTA };
