import { CALCADOS_PRIMEIRA_PALAVRA, DEPOSITOS_FORA_REPOSICAO, ZONA_BAIXO_GIRO } from "./config";
import { demandaFracionada, type DemandaFr } from "./demandaFr";
import { montarLayout, ruaDe, ruaForaDoLayout } from "./layoutFr";
import type { RmDados } from "./rm";
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
  produtoDesc: (pi: string) => string;
  ehCalcado: (pi: string) => boolean;
  limites: (pi: string) => Limites | null;
}

export interface Proposta extends Omit<Missao, "id" | "origem" | "status" | "criadaEm" | "atualizadoEm" | "concluidaEm" | "verificadaEm" | "motivoCancelamento" | "responsavel" | "obs" | "nota"> {
  nota: string;
}

/* ------------------------------------------------------------------ contexto */

export function montarContexto(dados: Dados, rm: RmDados | null, params: Parametros): Contexto {
  const linhasSc = new Map<string, Linha[]>();
  const ocupFr = new Map<string, Set<string>>();
  const livreLoc = new Map<string, number>();
  const livrePorId = new Map<string, number>();
  const areasLoc = new Map<string, Set<string>>();
  for (const l of dados.linhas) {
    if (dados.escopos[l.dep] !== "estoque") continue;
    const k = l.dep + "|" + l.end;
    if (l.disp > 0 || l.total > 0) {
      (areasLoc.get(k) ?? areasLoc.set(k, new Set()).get(k)!).add(l.area);
      if (l.area === "FR" && !DEPOSITOS_FORA_REPOSICAO.includes(l.dep)) (ocupFr.get(k) ?? ocupFr.set(k, new Set()).get(k)!).add(l.pi);
    }
    if (!l.livre || l.disp <= 0) continue;
    livreLoc.set(`${l.pi}|${k}`, (livreLoc.get(`${l.pi}|${k}`) ?? 0) + l.disp);
    livrePorId.set(l.id, (livrePorId.get(l.id) ?? 0) + l.disp);
    if (l.area === "SC") (linhasSc.get(l.pi) ?? linhasSc.set(l.pi, []).get(l.pi)!).push(l);
  }
  const dem = demandaFracionada(rm);
  const calcado = (pi: string) => CALCADOS_PRIMEIRA_PALAVRA.includes((dados.produtos[pi]?.desc ?? "").trim().split(/\s+/)[0]?.toUpperCase());
  const limites = (pi: string): Limites | null => {
    const cxp = dem.get(pi)?.cxp;
    if (!cxp) return null;
    const cal = calcado(pi);
    const maxCx = params.caixasPorPi[pi] > 0 ? params.caixasPorPi[pi] : cal ? params.maxCaixasCalcado : params.maxCaixas;
    const minCx = Math.min(maxCx, cal ? params.minCaixasCalcado : params.minCaixas);
    return { cxp, minCx, maxCx, minUn: minCx * cxp, maxUn: maxCx * cxp, calcado: cal };
  };
  return {
    dados, rm, params, estoqueEm: dados.atualizadoEm ?? "", est: estoquePorPi(dados), dem, linhasSc, ocupFr, livreLoc, livrePorId, areasLoc,
    produtoDesc: (pi) => dados.produtos[pi]?.desc ?? pi, ehCalcado: calcado, limites,
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
    if (ctx.dados.escopos[v.dep] === "estoque" && !DEPOSITOS_FORA_REPOSICAO.includes(v.dep) && !ruaForaDoLayout(v.dep, v.end) && !sim.has(k)) sim.set(k, new Map());
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
    if (ehZona(locDe(k)) || itens.size === 0) continue;
    for (const pi of itens.keys()) noFr.add(pi);
    const ativos = [...itens.keys()].filter((pi) => ctx.dem.get(pi)?.frac && !ctx.est.get(pi)?.noP04);
    if (!ativos.length) continue; // LOC só de itens sem pedido fracionado: fora do escopo do padrão
    c.locs++;
    let ok = true;
    if (itens.size > 1) { c.maisDeUmPi++; ok = false; }
    for (const pi of ativos) {
      const lim = ctx.limites(pi)!, it = itens.get(pi)!;
      if (Math.floor(it.qtd / lim.cxp + EPS) > lim.maxCx) { c.acimaDoMaximo++; ok = false; }
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
  const primLocs = () => todasLocs().filter((k) => !ehZona(locDe(k)));
  const protegido = (pi: string) => !!ctx.est.get(pi)?.noP04;

  // PIs ativos: já tiveram pedido fracionado, têm caixa padrão conhecida e algum saldo
  const scLivre = (pi: string) => (ctx.linhasSc.get(pi) ?? []).reduce((s, l) => s + Math.max(0, l.disp - (pendSc.get(l.id) ?? 0)), 0);
  const frTotal = (pi: string) => { let t = 0; for (const m of sim.values()) t += m.get(pi)?.qtd ?? 0; return t; };
  const ativos = [...ctx.dem.entries()]
    .filter(([pi, d]) => d.frac && !protegido(pi) && (frTotal(pi) > EPS || scLivre(pi) >= d.cxp - EPS))
    .sort((a, b) => b[1].n12 - a[1].n12 || b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .map(([pi]) => pi);
  const ehAtivo = new Set(ativos);

  // ---- 1) casa de cada PI ativo
  const casaLoc = new Map<string, string>(); // loc → pi
  const casaDe = new Map<string, string>(); // pi → loc
  const zonaPre = new Map<string, string>(); // pi → LOC da zona já definida por missão em andamento
  // 1.0) tabela mestre: a casa anterior continua valendo enquanto for válida (LOC existe no escopo e o PI segue ativo)
  for (const pi of ativos) {
    const k = casasPrev[pi];
    if (k && sim.has(k) && !ehZona(locDe(k)) && !casaLoc.has(k)) { casaLoc.set(k, pi); casaDe.set(pi, k); continue; }
    const z = zonaPrev[pi];
    if (z && sim.has(z) && ehZona(locDe(z))) zonaPre.set(pi, z);
  }
  // 1a) o destino de uma missão em andamento já é a casa do PI (o plano não muda de ideia entre planilhas)
  for (const m of [...efet].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!ehAtivo.has(m.pi) || casaDe.has(m.pi) || zonaPre.has(m.pi)) continue;
    const para = chaveLoc(m.para);
    if (!sim.has(para)) continue; // destino SC (devolução)
    if (ehZona(m.para)) { zonaPre.set(m.pi, para); continue; }
    if (!casaLoc.has(para)) { casaLoc.set(para, m.pi); casaDe.set(m.pi, para); }
  }
  // 1b) senão, a LOC onde ele já está (sozinho e com mais saldo)
  for (const pi of ativos) {
    if (casaDe.has(pi) || zonaPre.has(pi)) continue;
    const cand = primLocs().filter((k) => qtdSim(sim, k, pi) > EPS && !casaLoc.has(k))
      .sort((a, b) => Number(sim.get(b)!.size === 1) - Number(sim.get(a)!.size === 1) || qtdSim(sim, b, pi) - qtdSim(sim, a, pi) || (a < b ? -1 : 1));
    if (cand.length) { casaLoc.set(cand[0], pi); casaDe.set(pi, cand[0]); }
  }

  // destino SC para devolver excedentes
  const scUsadas = new Set<string>();
  const scDoPi = new Map<string, string>(); // pi → LOC SC escolhida (estável dentro da rodada)
  const locsScDoPi = (pi: string) => {
    const m = new Map<string, number>();
    for (const l of ctx.linhasSc.get(pi) ?? []) m.set(l.dep + "|" + l.end, (m.get(l.dep + "|" + l.end) ?? 0) + l.disp);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
  };
  const ocupadasSc = new Set<string>();
  for (const [k, ar] of ctx.areasLoc) if (ar.has("SC")) ocupadasSc.add(k);
  const destinoSc = (pi: string, depOrigem: string): string | null => {
    if (scDoPi.has(pi)) return scDoPi.get(pi)!;
    const proprias = locsScDoPi(pi);
    let k: string | undefined = proprias.find((x) => locDe(x).dep === depOrigem) ?? proprias[0];
    if (!k) k = params.locsVaziasSc.map(chaveLoc).find((x) => !ocupadasSc.has(x) && !scUsadas.has(x));
    if (!k) return null;
    scUsadas.add(k); scDoPi.set(pi, k);
    return k;
  };
  const podeDevolverSc = (pi: string) => !!ctx.dem.get(pi)?.cxp && (locsScDoPi(pi).length > 0 || params.locsVaziasSc.some((v) => !ocupadasSc.has(chaveLoc(v)) && !scUsadas.has(chaveLoc(v))) || scDoPi.has(pi));

  // ---- 2) quem ainda não tem casa: LOC livre de menor custo; senão, zona de baixo giro
  const preferDep = (pi: string) => {
    const por = new Map<string, number>();
    for (const l of ctx.linhasSc.get(pi) ?? []) por.set(l.dep, (por.get(l.dep) ?? 0) + l.disp);
    return [...por.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };
  const evictavel = (k: string) => {
    for (const [r, it] of sim.get(k)!) {
      if (it.bloq > EPS || protegido(r)) return false;
      if (!ehAtivo.has(r) && !podeDevolverSc(r)) return false;
    }
    return true;
  };
  const semCasa = ativos.filter((pi) => !casaDe.has(pi) && !zonaPre.has(pi));
  const naZona: string[] = [...zonaPre.keys()].sort();
  for (const pi of semCasa) {
    const pref = preferDep(pi);
    const cand = primLocs().filter((k) => !casaLoc.has(k) && evictavel(k)).map((k) => {
      const m = sim.get(k)!;
      let un = 0; for (const it of m.values()) un += it.qtd;
      return { k, vazia: m.size === 0 ? 0 : 1, depOk: locDe(k).dep === pref ? 0 : 1, n: m.size, un };
    }).sort((a, b) => a.vazia - b.vazia || a.depOk - b.depOk || a.n - b.n || a.un - b.un || (a.k < b.k ? -1 : 1));
    if (cand.length) { casaLoc.set(cand[0].k, pi); casaDe.set(pi, cand[0].k); } else naZona.push(pi);
  }
  // 2b) falta de LOC: quem tem MENOS saída cede a LOC para quem tem MAIS saída e vai para a zona de baixo giro.
  //     Com folga (50% + 2 pedidos) para o plano não oscilar por pequenas variações; não mexe em LOC que é destino de missão em andamento.
  const comMissao = new Set<string>();
  for (const m of efet) comMissao.add(chaveLoc(m.para));
  const maisSaida = (x: string, y: string) => ctx.dem.get(x)!.n12 > ctx.dem.get(y)!.n12 * 1.5 + 2;
  const faltantes = ativos.filter((pi) => !casaDe.has(pi));
  const donos = ativos.filter((pi) => casaDe.has(pi)).reverse(); // do menor giro para o maior
  const evictavelSem = (k: string, dono: string) => {
    for (const [r, it] of sim.get(k)!) {
      if (r === dono) { if (it.bloq > EPS) return false; continue; }
      if (it.bloq > EPS || protegido(r)) return false;
      if (!ehAtivo.has(r) && !podeDevolverSc(r)) return false;
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
  const zonaLocs = todasLocs().filter((k) => ehZona(locDe(k)));
  const zonaDe = new Map<string, string>();
  // ocupação futura da zona: quem tem casa própria vai embora da zona, então não ocupa vaga
  const ocupZona = new Map<string, number>(zonaLocs.map((k) => [k, [...sim.get(k)!.keys()].filter((pi) => !(ehAtivo.has(pi) && casaDe.has(pi))).length]));
  const semLugar: string[] = [];
  const semLugarPis: string[] = [];
  naZona.length = 0;
  for (const pi of ativos) if (!casaDe.has(pi)) naZona.push(pi); // ordem de prioridade: os de maior saída pegam vaga primeiro
  for (const pi of naZona) {
    const ja = zonaPre.get(pi) ?? zonaLocs.find((k) => sim.get(k)!.has(pi));
    const k = ja ?? zonaLocs.filter((z) => (ocupZona.get(z) ?? 0) < params.pisPorLocZona).sort((a, b) => (ocupZona.get(a)! - ocupZona.get(b)!) || (a < b ? -1 : 1))[0];
    if (!k) { semLugar.push(nome(pi)); semLugarPis.push(pi); continue; }
    zonaDe.set(pi, k);
    // só não soma se o PI já está fisicamente na LOC (já contado); PI da tabela mestre ainda sem saldo lá também ocupa vaga
    if (!sim.get(k)?.has(pi)) ocupZona.set(k, (ocupZona.get(k) ?? 0) + 1);
  }

  // ---- 3) movimentações FR→FR e FR→SC
  const propostas: Proposta[] = [];
  const semDestinoSc: string[] = [], bloqueios: string[] = [];
  const baseDe = (pi: string, k: string) => ctx.livreLoc.get(`${pi}|${k}`) ?? 0;
  const novaProposta = (tipo: TipoMissao, pi: string, de: Local, para: Local, qtd: number, prioridade: 1 | 2 | 3, motivo: string, extra: Partial<Proposta> = {}): Proposta => ({
    tipo, prioridade, onda: 1, pi, desc: ctx.produtoDesc(pi), qtd, caixas: extra.caixas ?? null, de, para, lote: extra.lote ?? "", validade: extra.validade ?? "",
    idQuant: extra.idQuant ?? "", motivo, chave: extra.chave ?? "", baseOrigem: baseDe(pi, chaveLoc(de)), baseDestino: baseDe(pi, chaveLoc(para)),
    baseEm: ctx.estoqueEm, nota: "", freq: ctx.dem.get(pi)?.freqTexto ?? "", qtdMediaPedido: Math.round((ctx.dem.get(pi)?.qtdMediaPedido ?? 0) * 10) / 10,
  });
  const limFr = (pi: string, k: string): number => {
    const lim = ctx.limites(pi);
    if (!lim) return Infinity;
    return ehZona(locDe(k)) ? Math.min(lim.maxUn, params.caixasZona * lim.cxp) : lim.maxUn;
  };

  const semCxp: string[] = [], soltas: string[] = [];
  /** FR → SC: SEMPRE em caixas fechadas (múltiplo da CXP). O que sobra solto (menos de 1 caixa) não volta. Devolve true se criou a missão. */
  const devolver = (pi: string, k: string, qtd: number, motivo: string, prioridade: 1 | 2 | 3): boolean => {
    const cxp = ctx.dem.get(pi)?.cxp;
    const loc = k.replace("|", " ");
    if (!cxp) { semCxp.push(`${nome(pi)} (${fmt(qtd)} un em ${loc})`); return false; }
    const disponivel = sim.get(k)?.get(pi)?.qtd ?? 0;
    const caixas = Math.floor(Math.min(qtd, disponivel) / cxp + EPS);
    if (caixas <= 0) { soltas.push(`${nome(pi)} (${fmt(Math.min(qtd, disponivel))} un soltas, menos de 1 caixa de ${fmt(cxp)}, em ${loc})`); return false; }
    const sc = destinoSc(pi, locDe(k).dep);
    if (!sc) { semDestinoSc.push(`${nome(pi)} (${caixas} caixa(s) em ${loc})`); return false; }
    const q = caixas * cxp;
    propostas.push(novaProposta("movimentacao", pi, locDe(k), locDe(sc), q, prioridade, motivo, { chave: `A|${pi}|${k}|SC:${sc}`, caixas }));
    sairSim(sim, k, pi, q);
    return true;
  };

  for (const k of todasLocs()) {
    const itens = [...sim.get(k)!.keys()].sort();
    const zona = ehZona(locDe(k));
    for (const pi of itens) {
      const it = sim.get(k)?.get(pi);
      if (!it || protegido(pi)) continue;
      const alvo = casaDe.get(pi) ?? zonaDe.get(pi) ?? null;
      if (alvo === k) continue;
      const movivel = it.qtd - it.bloq;
      if (!alvo) {
        // PI sem lugar definido (inativo ou sem LOC): só sai se estiver atrapalhando a casa de outro PI
        if (zona || !casaLoc.has(k)) continue;
        if (movivel <= EPS) { bloqueios.push(`${nome(pi)} na LOC ${k.replace("|", " ")}`); continue; }
        devolver(pi, k, movivel, ehAtivo.has(pi)
          ? `Sem LOC disponível no FR para este PI (baixa saída): liberar a LOC ${locDe(k).end}, casa do PI ${casaLoc.get(k)}, devolvendo ao SC`
          : `Tirar do FR: a LOC ${locDe(k).end} é a casa do PI ${casaLoc.get(k)} e este PI não tem pedido fracionado`, 2);
        continue;
      }
      if (movivel <= EPS) { bloqueios.push(`${nome(pi)} na LOC ${k.replace("|", " ")}`); continue; }
      const room = Math.max(0, limFr(pi, alvo) - qtdSim(sim, alvo, pi));
      let q = Math.min(movivel, room);
      // o que não cabe na casa: caixas inteiras voltam ao SC; a sobra solta (menos de 1 caixa) vai junto para a casa
      const resto = movivel - q;
      const cxp = ctx.dem.get(pi)?.cxp ?? 0;
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
          !ehZona(locDe(alvo)) ? `Juntar o PI na sua LOC ${locDe(alvo).end} (1 PI por LOC)` : `Levar para a zona de baixo giro (${locDe(alvo).end}): falta LOC própria`,
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
    const fontes = (ctx.linhasSc.get(pi) ?? [])
      .map((l) => ({ l, livre: l.disp - (pendSc.get(l.id) ?? 0) }))
      .filter((x) => x.livre >= lim.cxp - EPS)
      .sort((a, b) => Number(b.l.dep === depAlvo) - Number(a.l.dep === depAlvo) || (a.l.val || "9999").localeCompare(b.l.val || "9999") || a.livre - b.livre || (a.l.id < b.l.id ? -1 : 1));
    const inicial = precisa;
    for (const f of fontes) {
      if (precisa <= 0) break;
      const take = Math.min(Math.floor(f.livre / lim.cxp + EPS), precisa);
      if (take <= 0) continue;
      propostas.push(novaProposta("recompletamento", pi, { dep: f.l.dep, end: f.l.end }, locDe(alvo), take * lim.cxp, cur <= EPS ? 1 : 2,
        `FR com ${fmt(cur)} un (mínimo ${lim.minCx} caixa(s) de ${fmt(lim.cxp)}); repor até ${alvoCx} caixa(s) = ${params.pedidosCobertura} pedido(s) fracionado(s) médio(s) de ${fmt(d.qtdMediaPedido)} un`,
        { caixas: take, lote: f.l.lote, validade: f.l.val, idQuant: f.l.id, chave: `R|${pi}|${f.l.id}|${alvo}` }));
      pendSc.set(f.l.id, (pendSc.get(f.l.id) ?? 0) + take * lim.cxp);
      entrarSim(sim, alvo, pi, take * lim.cxp);
      precisa -= take;
    }
    if (precisa > 0) {
      const e = ctx.est.get(pi);
      const txt = nome(pi);
      if (precisa === inicial) { if ((e?.bloq ?? 0) > 0 || (e?.sc ?? 0) > 0) semOrigem.push(txt); } else parcial.push(`${txt} (faltam ${precisa} caixa(s))`);
    }
  }

  // ---- 5) ondas: quem entra numa LOC que ainda tem outro PI só depois que esse PI sair (onda 2)
  const saidas = new Map<string, Set<string>>(); // LOC → PIs que saem dela por missão
  for (const p of propostas) if (p.tipo === "movimentacao") (saidas.get(chaveLoc(p.de)) ?? saidas.set(chaveLoc(p.de), new Set()).get(chaveLoc(p.de))!).add(p.pi);
  for (const p of propostas) {
    const dest = chaveLoc(p.para);
    const estranhos = [...(ctx.ocupFr.get(dest) ?? [])].filter((x) => x !== p.pi && (saidas.get(dest)?.has(x) ?? false));
    if (estranhos.length) {
      p.onda = 2;
      // troca de LOCs (A→B e B→A): não dá para ordenar, executar juntas
      const troca = propostas.find((q) => q !== p && chaveLoc(q.de) === dest && chaveLoc(q.para) === chaveLoc(p.de));
      if (troca) { p.onda = 1; troca.onda = 1; p.nota = troca.nota = "Troca entre duas LOCs: executar as duas missões juntas"; }
    }
  }

  // saída de uma LOC que recebe o mesmo PI por outra missão (juntar e depois devolver caixa fechada): só depois da chegada
  for (const p of propostas) {
    if (p.tipo !== "movimentacao") continue;
    if (propostas.some((q) => q !== p && q.pi === p.pi && chaveLoc(q.para) === chaveLoc(p.de))) p.onda = 2;
  }

  const alertas: Alerta[] = [];
  const mk = (id: string, nivel: Alerta["nivel"], regra: string, titulo: string, detalhe: string, lista: string[], tipo: TipoMissao) => {
    if (lista.length) alertas.push({ id, nivel, regra, titulo, detalhe, tipo, total: lista.length, exemplos: lista.slice(0, 8) });
  };
  mk("rc-sem-origem", "critico", "Recompletamento precisa de caixas fechadas em SC", "FR abaixo do mínimo sem caixa fechada livre em SC", "Não há caixa fechada livre em SC para repor (o saldo pode estar bloqueado ou fracionado).", semOrigem, "recompletamento");
  mk("rc-parcial", "atencao", "Recompletamento cobre a meta", "SC não cobre toda a reposição necessária", "Há caixas em SC, mas não o bastante para atingir a meta.", parcial, "recompletamento");
  mk("mv-sem-destino-sc", "atencao", "Excedente volta para o SC", "Sem LOC SC para devolver o excedente", "O PI não tem LOC SC e não há LOC SC vazia informada. Informe LOCs SC vazias em Parâmetros.", semDestinoSc, "movimentacao");
  mk("mv-sem-cxp", "atencao", "FR → SC em caixas fechadas", "Sem caixa padrão (CXP) para devolver ao SC", "A devolução ao SC só é feita em caixas fechadas, e este PI não tem CXP conhecida (nenhum pedido na planilha de pedidos).", semCxp, "movimentacao");
  mk("mv-soltas", "info", "FR → SC em caixas fechadas", "Sobra solta (menos de 1 caixa) não volta ao SC", "Só caixas fechadas voltam ao SC; unidades soltas menores que 1 caixa permanecem na LOC.", soltas, "movimentacao");
  mk("mv-bloqueio", "atencao", "1 PI por LOC", "Saldo bloqueado impede esvaziar a LOC", "O PI tem saldo bloqueado nesta LOC: resolva o bloqueio antes de movimentar.", bloqueios, "movimentacao");
  mk("mv-sem-lugar", "critico", "Todo PI fracionado precisa de uma LOC",
    `Faltou LOC até na zona de baixo giro: ${semLugar.length} PI(s) sem lugar`,
    `Há ${ativos.length} PIs com fracionado, ${casaDe.size} com LOC própria e ${zonaDe.size} na zona de baixo giro (rua 01 do P02: ${zonaLocs.length} LOCs × ${params.pisPorLocZona} PIs). Faltam LOCs para ${semLugar.length} PIs (os de menor saída); o saldo deles no FR é devolvido ao SC. Para mantê-los no FR, informe LOCs FR vazias em Parâmetros (da rua 01 do P02, de preferência) ou aumente "PIs por LOC da zona".`,
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
      else out.set(m.id, { estado: "divergente", nota: "Saiu da origem mas não apareceu no destino: confira o endereço ou se o item foi perdido." });
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

  // 1) verificação: só das missões cuja "foto" é anterior à planilha atual
  const paraVerificar = Object.values(estado.missoes).filter((m) => EM_ANDAMENTO(m.status) && ctx.estoqueEm > (m.baseEm ?? ""));
  const res = verificarMissoes(paraVerificar, ctx);
  for (const m of paraVerificar) {
    const v = res.get(m.id)!;
    if (v.estado === "concluida") { m.status = "concluida"; m.verificadaEm = agora; m.concluidaEm = m.concluidaEm ?? agora; m.nota = v.nota; m.atualizadoEm = agora; mudou = true; continue; }
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
    if (lim && !ehZona(m.para) && Math.floor((emDest + m.qtd) / lim.cxp + EPS) > lim.maxCx && m.para.dep && ctx.areasLoc.get(chaveLoc(m.para))?.has("FR")) estouro.push(`${m.id} · ${m.pi}: ${fmt(emDest + m.qtd)} un no destino > máximo ${fmt(lim.maxUn)}`);
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
    if (areasPara?.has("SC") && !areasPara.has("FR") && !cxp) aviso("Caixa padrão (CXP) deste PI não conhecida: não dá para conferir se a devolução ao SC é em caixas fechadas.");
  }
  if (areasPara?.has("FR")) {
    const ocupDest = ctx.ocupFr.get(chaveLoc(e.para)) ?? new Set<string>();
    const outros = [...ocupDest].filter((p) => p !== e.pi);
    if (outros.length && !ocupDest.has(e.pi) && !ehZona(e.para)) aviso(`O destino já tem outro PI (${outros.slice(0, 3).join(", ")}): a regra de 1 PI por LOC será quebrada.`);
    const noDest = ctx.livreLoc.get(`${e.pi}|${chaveLoc(e.para)}`) ?? 0;
    if (lim && Math.floor((noDest + qtd) / lim.cxp + EPS) > lim.maxCx) aviso(`O destino ficaria com ${fmt(noDest + qtd)} un, acima do máximo de ${lim.maxCx} caixa(s) (${fmt(lim.maxUn)} un).`);
  }
  if (ctx.est.get(e.pi)?.noP04) aviso("Este PI tem saldo no P04, que fica fora das regras de reposição.");
  return { avisos: av, qtd };
}

export { ABERTA };
