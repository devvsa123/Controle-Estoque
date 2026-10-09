import { DEPOSITOS_FORA_REPOSICAO } from "./config";
import { montarLayout } from "./layoutFr";
import type { RmDados } from "./rm";
import { classificar, estoquePorPi } from "./rmAnalise";
import type { Dados, Linha } from "./types";
import {
  ABERTA, type Alerta, type AvisoValidacao, type EstadoMissoes, type Local, type Missao, type Parametros, type TipoMissao,
} from "./missoes";

/* =====================================================================================
 *  REGRAS (resumo — a tela mostra o mesmo texto)
 *
 *  RECOMPLETAMENTO (SC → FR). Vale para PIs que já tiveram pedido fracionado e não têm
 *  saldo no P04. Dispara quando o saldo livre no FR fica abaixo de `minCaixasFr` caixas
 *  padrão. Repõe até a cobertura de `diasAlvo` dias (média de saída), no mínimo
 *  `minCaixasFr` caixa(s) e no máximo o que cabe na LOC (`caixasLoc`). Só caixas fechadas,
 *  tiradas de linhas SC livres: mesmo paiol primeiro, depois a validade mais próxima (FEFO).
 *  Destino = LOC FR do PI com maior saldo (de preferência onde ele está sozinho).
 *
 *  MOVIMENTAÇÃO PARA AJUSTE DO FR. Objetivo: 1 PI por LOC. (1) PI espalhado em várias LOCs
 *  é juntado na LOC principal, se couber. (2) Em LOC com mais de um PI, fica o PI com giro
 *  fracionado (ou o de maior saldo) e os outros vão para a LOC onde já estão sozinhos ou
 *  para uma LOC vazia informada em Parâmetros. Sem destino, vira alerta (nunca inventa LOC).
 *  Fora das duas regras: P04 e a rua 12 do P02 (mesma exclusão da análise de layout).
 * ===================================================================================== */

const GIRO_DIAS = 365;
const EPS = 1e-9;

export const chaveLoc = (l: Local) => `${l.dep}|${l.end}`;

export interface Demanda {
  cxp: number;
  media: number; // unidades/dia de sobra na janela
  frac: boolean; // já teve pedido fracionado
  giro: boolean; // teve pedido fracionado nos últimos GIRO_DIAS
}

export interface Contexto {
  dados: Dados;
  rm: RmDados | null;
  params: Parametros;
  estoqueEm: string; // ISO da planilha de estoque
  est: ReturnType<typeof estoquePorPi>;
  demanda: Map<string, Demanda>;
  linhasSc: Map<string, Linha[]>; // por PI: linhas SC livres
  locsFr: Map<string, { dep: string; end: string; qtd: number }[]>; // por PI: LOCs FR com saldo livre
  ocupFr: Map<string, Set<string>>; // LOC FR → PIs presentes (qualquer status)
  livreLoc: Map<string, number>; // "pi|dep|end" → saldo livre
  livrePorId: Map<string, number>; // ID_QUANT → saldo livre
  areasLoc: Map<string, Set<string>>; // LOC → áreas
  produtoDesc: (pi: string) => string;
}

export interface Proposta extends Omit<Missao, "id" | "origem" | "status" | "criadaEm" | "atualizadoEm" | "concluidaEm" | "motivoCancelamento" | "responsavel" | "obs"> {}

export function capacidadeUn(ctx: Contexto, pi: string): number {
  const cx = ctx.demanda.get(pi)?.cxp;
  if (!cx) return Infinity;
  return (ctx.params.caixasPorPi[pi] > 0 ? ctx.params.caixasPorPi[pi] : ctx.params.caixasLoc) * cx;
}

/* ------------------------------------------------------------------ contexto */

function montarDemanda(rm: RmDados | null, params: Parametros): Map<string, Demanda> {
  const out = new Map<string, Demanda>();
  if (!rm || !rm.d.length) return out;
  let ultimo = -Infinity, primeiro = Infinity;
  for (const d of rm.d) { if (d > ultimo) ultimo = d; if (d < primeiro) primeiro = d; }
  const span = ultimo - primeiro + 1;
  const jan = params.janela > 0 ? Math.min(params.janela, span) : span;
  const dJan = ultimo - jan + 1, dGiro = ultimo - GIRO_DIAS + 1;
  const ult = new Map<number, { dia: number; cxp: number }>();
  const acc = new Map<number, { sobraJan: number; frac: boolean; giro: boolean }>();
  for (let i = 0; i < rm.p.length; i++) {
    const p = rm.p[i];
    const u = ult.get(p);
    if (!u || rm.d[i] >= u.dia) ult.set(p, { dia: rm.d[i], cxp: rm.c[i] });
    const cl = classificar(rm.q[i], rm.c[i]);
    if (cl.grupo === 0) continue;
    let a = acc.get(p);
    if (!a) acc.set(p, (a = { sobraJan: 0, frac: true, giro: false }));
    if (rm.d[i] >= dJan) a.sobraJan += cl.sobra;
    if (rm.d[i] >= dGiro) a.giro = true;
  }
  for (const [p, u] of ult) {
    const a = acc.get(p);
    out.set(rm.pis[p][0], { cxp: u.cxp, media: a ? a.sobraJan / jan : 0, frac: !!a, giro: a?.giro ?? false });
  }
  return out;
}

export function montarContexto(dados: Dados, rm: RmDados | null, params: Parametros): Contexto {
  const linhasSc = new Map<string, Linha[]>();
  const locsFrMap = new Map<string, Map<string, number>>();
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
    if (l.area === "FR" && !DEPOSITOS_FORA_REPOSICAO.includes(l.dep)) {
      const m = locsFrMap.get(l.pi) ?? locsFrMap.set(l.pi, new Map()).get(l.pi)!;
      m.set(k, (m.get(k) ?? 0) + l.disp);
    }
  }
  const locsFr = new Map<string, { dep: string; end: string; qtd: number }[]>();
  for (const [pi, m] of locsFrMap)
    locsFr.set(pi, [...m.entries()].map(([k, qtd]) => { const [dep, end] = k.split("|"); return { dep, end, qtd }; }).sort((a, b) => b.qtd - a.qtd));
  return {
    dados, rm, params, estoqueEm: dados.atualizadoEm ?? "", est: estoquePorPi(dados), demanda: montarDemanda(rm, params),
    linhasSc, locsFr, ocupFr, livreLoc, livrePorId, areasLoc, produtoDesc: (pi) => dados.produtos[pi]?.desc ?? pi,
  };
}

/** Missões que já contam como "a caminho": abertas + concluídas que a planilha de estoque ainda não reflete. */
export function efetivas(missoes: Missao[], estoqueEm: string): Missao[] {
  return missoes.filter((m) => ABERTA(m.status) || (m.status === "concluida" && !!m.concluidaEm && m.concluidaEm > estoqueEm));
}

const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/* ------------------------------------------------------------ recompletamento */

export function gerarRecompletamento(ctx: Contexto, efet: Missao[]): { propostas: Proposta[]; alertas: Alerta[] } {
  const propostas: Proposta[] = [], alertas: Alerta[] = [];
  const { params } = ctx;
  const pendFr = new Map<string, number>(), pendSc = new Map<string, number>();
  for (const m of efet) if (m.tipo === "recompletamento") {
    pendFr.set(m.pi, (pendFr.get(m.pi) ?? 0) + m.qtd);
    if (m.idQuant) pendSc.set(m.idQuant, (pendSc.get(m.idQuant) ?? 0) + m.qtd);
  }
  const semOrigem: string[] = [], semDestino: string[] = [], parcial: string[] = [];
  for (const [pi, d] of ctx.demanda) {
    if (!d.frac) continue;
    const e = ctx.est.get(pi);
    if (e?.noP04) continue;
    const c = d.cxp;
    const frAtual = (e?.fr ?? 0) + (pendFr.get(pi) ?? 0);
    if (frAtual >= params.minCaixasFr * c - EPS) continue;
    const temSc = (e?.sc ?? 0) >= c - EPS;
    const destinos = ctx.locsFr.get(pi) ?? [];
    if (!destinos.length) { if (temSc || (e?.bloq ?? 0) > 0) semDestino.push(`${pi} · ${ctx.produtoDesc(pi)}`); continue; }
    const dest = destinos.find((x) => (ctx.ocupFr.get(x.dep + "|" + x.end)?.size ?? 1) === 1) ?? destinos[0];
    const cxLoc = params.caixasPorPi[pi] > 0 ? params.caixasPorPi[pi] : params.caixasLoc;
    const alvoCx = Math.min(cxLoc, Math.max(params.minCaixasFr, Math.ceil((params.diasAlvo * d.media) / c - EPS)));
    const atualCx = Math.floor(frAtual / c + EPS);
    const espacoCx = Math.floor((cxLoc * c - frAtual) / c + EPS);
    let precisa = Math.min(alvoCx - atualCx, espacoCx);
    if (precisa <= 0) continue;
    const fontes = (ctx.linhasSc.get(pi) ?? [])
      .map((l) => ({ l, livre: l.disp - (pendSc.get(l.id) ?? 0) }))
      .filter((x) => x.livre >= c - EPS)
      .sort((a, b) =>
        Number(b.l.dep === dest.dep) - Number(a.l.dep === dest.dep) ||
        (a.l.val || "9999").localeCompare(b.l.val || "9999") ||
        a.livre - b.livre);
    const inicial = precisa;
    for (const f of fontes) {
      if (precisa <= 0) break;
      const take = Math.min(Math.floor(f.livre / c + EPS), precisa);
      if (take <= 0) continue;
      propostas.push({
        tipo: "recompletamento", prioridade: frAtual <= EPS ? 1 : 2, pi, desc: ctx.produtoDesc(pi), qtd: take * c, caixas: take,
        de: { dep: f.l.dep, end: f.l.end }, para: { dep: dest.dep, end: dest.end }, lote: f.l.lote, validade: f.l.val, idQuant: f.l.id,
        motivo: `FR com ${fmt(frAtual)} un (mínimo ${params.minCaixasFr} caixa(s) de ${fmt(c)}); repor até ${alvoCx} caixa(s)`,
        chave: `R|${pi}|${f.l.id}|${dest.dep}|${dest.end}`,
      });
      precisa -= take;
    }
    if (precisa > 0) {
      const txt = `${pi} · ${ctx.produtoDesc(pi)}`;
      if (precisa === inicial) { if ((e?.bloq ?? 0) > 0 || temSc) semOrigem.push(txt); }
      else parcial.push(`${txt} (faltam ${precisa} caixa(s))`);
    }
  }
  propostas.sort((a, b) => a.prioridade - b.prioridade);
  const mk = (id: string, nivel: Alerta["nivel"], regra: string, titulo: string, detalhe: string, lista: string[]) => {
    if (lista.length) alertas.push({ id, nivel, regra, titulo, detalhe, tipo: "recompletamento", total: lista.length, exemplos: lista.slice(0, 8) });
  };
  mk("rc-sem-destino", "critico", "PI fracionado precisa de uma LOC FR", "PI fracionado abaixo do mínimo sem LOC FR de destino", "Não há LOC FR com saldo livre deste PI para receber o recompletamento. Defina uma LOC (missão manual ou LOC vazia nos parâmetros).", semDestino);
  mk("rc-sem-origem", "critico", "Recompletamento precisa de caixas fechadas em SC", "FR abaixo do mínimo sem caixa fechada livre em SC", "Não há caixa fechada livre em SC para repor (o saldo pode estar bloqueado ou fracionado).", semOrigem);
  mk("rc-parcial", "atencao", "Recompletamento cobre a meta", "SC não cobre toda a reposição necessária", "Há caixas em SC, mas não o bastante para atingir a meta de cobertura.", parcial);
  return { propostas, alertas };
}

/* ---------------------------------------------------------------- movimentação */

interface SimItem { qtd: number; bloq: number }
type Sim = Map<string, { dep: string; end: string; itens: Map<string, SimItem> }>;

function montarSim(ctx: Contexto): Sim {
  const sim: Sim = new Map();
  for (const l of montarLayout(ctx.dados, true).locs) {
    const itens = new Map<string, SimItem>();
    for (const it of l.itens) itens.set(it.pi, { qtd: it.qtd, bloq: it.bloq });
    sim.set(l.loc, { dep: l.dep, end: l.end, itens });
  }
  return sim;
}

function aplicar(sim: Sim, pi: string, de: Local, para: Local, qtd: number) {
  const a = sim.get(chaveLoc(de));
  const it = a?.itens.get(pi);
  if (!a || !it) return;
  it.qtd -= qtd;
  if (it.qtd <= EPS && it.bloq <= EPS) a.itens.delete(pi);
  let b = sim.get(chaveLoc(para));
  if (!b) sim.set(chaveLoc(para), (b = { dep: para.dep, end: para.end, itens: new Map() }));
  const dst = b.itens.get(pi);
  if (dst) dst.qtd += qtd; else b.itens.set(pi, { qtd, bloq: 0 });
}

export function gerarMovimentacao(ctx: Contexto, efet: Missao[]): { propostas: Proposta[]; alertas: Alerta[]; multiPi: number } {
  const propostas: Proposta[] = [];
  const sim = montarSim(ctx);
  for (const m of efet) if (m.tipo === "movimentacao") aplicar(sim, m.pi, m.de, m.para, m.qtd);
  const multiPi = [...sim.values()].filter((l) => l.itens.size > 1).length;
  const vazias = ctx.params.locsVazias.map(chaveLoc).filter((k) => !(sim.get(k)?.itens.size));
  const usadasVazias = new Set<string>();
  const semDestino: string[] = [], bloqueiaMov: string[] = [], naoCabe: string[] = [];
  const nome = (pi: string) => `${pi} · ${ctx.produtoDesc(pi)}`;
  const push = (pi: string, de: Local, para: Local, qtd: number, prioridade: 1 | 2 | 3, motivo: string) => {
    propostas.push({
      tipo: "movimentacao", prioridade, pi, desc: ctx.produtoDesc(pi), qtd, caixas: null, de, para, lote: "", validade: "", idQuant: "",
      motivo, chave: `A|${pi}|${de.dep}|${de.end}|${para.dep}|${para.end}`,
    });
    aplicar(sim, pi, de, para, qtd);
  };

  // (1) Juntar PIs espalhados em várias LOCs na LOC principal
  const locsDoPi = new Map<string, string[]>();
  for (const [k, l] of sim) for (const pi of l.itens.keys()) (locsDoPi.get(pi) ?? locsDoPi.set(pi, []).get(pi)!).push(k);
  for (const [pi, ks] of locsDoPi) {
    if (ks.length < 2) continue;
    const cap = capacidadeUn(ctx, pi);
    const ord = [...ks].sort((a, b) => {
      const la = sim.get(a)!, lb = sim.get(b)!;
      return Number(lb.itens.size === 1) - Number(la.itens.size === 1) || lb.itens.get(pi)!.qtd - la.itens.get(pi)!.qtd;
    });
    const mainK = ord[0], main = sim.get(mainK)!;
    // Só junta numa LOC onde o PI está sozinho; senão levaria o PI para uma LOC mista (a desmistura trata esses casos)
    if (main.itens.size !== 1) continue;
    for (const k of ord.slice(1)) {
      const src = sim.get(k)!;
      const it = src.itens.get(pi);
      if (!it) continue;
      const movivel = it.qtd - it.bloq;
      const room = cap - main.itens.get(pi)!.qtd;
      const q = Math.min(movivel, room);
      if (q <= EPS) { if (movivel > EPS && room <= EPS) naoCabe.push(`${nome(pi)} (LOC ${main.end} cheia)`); continue; }
      push(pi, { dep: src.dep, end: src.end }, { dep: main.dep, end: main.end }, q,
        ks.length >= 4 ? 1 : 2, `Juntar o PI, que está em ${ks.length} LOCs FR, na LOC principal ${main.end}`);
    }
  }

  // (2) Desmisturar LOCs com mais de um PI
  const mistas = [...sim.entries()].filter(([, l]) => l.itens.size > 1).sort((a, b) => b[1].itens.size - a[1].itens.size);
  for (const [k, loc] of mistas) {
    if (loc.itens.size < 2) continue;
    const score = (pi: string, it: SimItem) => (it.bloq > 0 ? 1e12 : 0) + (ctx.demanda.get(pi)?.giro ? 1e9 : 0) + it.qtd;
    const itens = [...loc.itens.entries()].sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]));
    const ficaPi = itens[0][0];
    for (const [pi, it] of itens.slice(1)) {
      const movivel = it.qtd - it.bloq;
      if (it.bloq > EPS) { bloqueiaMov.push(`${nome(pi)} na LOC ${loc.end}`); continue; }
      if (movivel <= EPS) continue;
      const cap = capacidadeUn(ctx, pi);
      // (a) outra LOC onde o próprio PI já está sozinho e ainda cabe
      let dest: { dep: string; end: string; k: string; q: number } | null = null;
      for (const [k2, l2] of sim) {
        if (k2 === k || l2.itens.size !== 1 || !l2.itens.has(pi)) continue;
        const room = cap - l2.itens.get(pi)!.qtd;
        if (room > EPS && (!dest || l2.itens.get(pi)!.qtd > sim.get(dest.k)!.itens.get(pi)!.qtd)) dest = { dep: l2.dep, end: l2.end, k: k2, q: Math.min(movivel, room) };
      }
      // (b) LOC vazia informada, só para PI com demanda fracionada
      if (!dest && (ctx.demanda.get(pi)?.frac ?? false)) {
        const livre = vazias.find((v) => !usadasVazias.has(v));
        if (livre) { const [dep, end] = livre.split("|"); usadasVazias.add(livre); dest = { dep, end, k: livre, q: movivel }; }
      }
      if (!dest) { semDestino.push(`${nome(pi)} na LOC ${loc.end} (junto com ${nome(ficaPi)})`); continue; }
      push(pi, { dep: loc.dep, end: loc.end }, { dep: dest.dep, end: dest.end }, dest.q, loc.itens.size >= 4 ? 1 : 2,
        `Desmisturar a LOC ${loc.end} (${itens.length} PIs): fica o PI ${ficaPi}`);
    }
  }

  const alertas: Alerta[] = [];
  const mk = (id: string, nivel: Alerta["nivel"], regra: string, titulo: string, detalhe: string, lista: string[]) => {
    if (lista.length) alertas.push({ id, nivel, regra, titulo, detalhe, tipo: "movimentacao", total: lista.length, exemplos: lista.slice(0, 8) });
  };
  mk("mv-sem-destino", "atencao", "1 PI por LOC", "PI em LOC compartilhada sem destino", "Não há LOC onde o PI já esteja sozinho nem LOC vazia informada. Informe LOCs vazias nos parâmetros ou crie uma missão manual.", semDestino);
  mk("mv-bloqueio", "atencao", "1 PI por LOC", "Saldo bloqueado impede desmisturar a LOC", "O PI tem saldo bloqueado nesta LOC: resolva o bloqueio antes de movimentar.", bloqueiaMov);
  mk("mv-nao-cabe", "atencao", "Capacidade da LOC", "LOC principal sem espaço para juntar o PI", "A LOC principal do PI já está na capacidade (caixas por LOC × caixa padrão).", naoCabe);
  propostas.sort((a, b) => a.prioridade - b.prioridade);
  return { propostas, alertas, multiPi };
}

/* ------------------------------------------------------------ sincronização */

const DIA = 86400000;

/** Cria as missões novas, cancela as obsoletas e poda o histórico. Devolve true se algo mudou. */
export function sincronizar(estado: EstadoMissoes, propostas: Proposta[], ctx: Contexto, agora: string): boolean {
  let mudou = false;
  const lista = Object.values(estado.missoes);
  const existentes = new Set(efetivas(lista, ctx.estoqueEm).map((m) => m.chave).filter(Boolean));

  // 1) missões automáticas pendentes que perderam o sentido
  for (const m of lista) {
    if (m.origem !== "auto" || m.status !== "pendente") continue;
    let motivo = "";
    if (m.tipo === "recompletamento") {
      const d = ctx.demanda.get(m.pi);
      const fr = ctx.est.get(m.pi)?.fr ?? 0;
      if (d && fr >= ctx.params.minCaixasFr * d.cxp - EPS) motivo = "FR já está no mínimo";
      else if (ctx.est.get(m.pi)?.noP04) motivo = "PI passou a ter saldo no P04";
      else if ((ctx.livrePorId.get(m.idQuant) ?? 0) < m.qtd - EPS) motivo = "origem sem saldo livre suficiente";
    } else {
      if ((ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.de)}`) ?? 0) < m.qtd - EPS) motivo = "origem sem saldo livre suficiente";
      else {
        const outros = [...(ctx.ocupFr.get(chaveLoc(m.para)) ?? [])].filter((p) => p !== m.pi);
        if (outros.length) motivo = "destino passou a ter outro PI";
      }
    }
    if (motivo) { m.status = "cancelada"; m.motivoCancelamento = `Automático: ${motivo}`; m.atualizadoEm = agora; mudou = true; }
  }

  // 2) missões novas, respeitando o limite de abertas automáticas por tipo
  const abertasAuto = (t: TipoMissao) => Object.values(estado.missoes).filter((m) => m.origem === "auto" && m.tipo === t && ABERTA(m.status)).length;
  const cont = { recompletamento: abertasAuto("recompletamento"), movimentacao: abertasAuto("movimentacao") };
  const lim = { recompletamento: ctx.params.limiteRecomp, movimentacao: ctx.params.limiteMov };
  for (const p of propostas) {
    if (existentes.has(p.chave) || cont[p.tipo] >= lim[p.tipo]) continue;
    const letra = p.tipo === "recompletamento" ? "R" : "A";
    const n = ++estado.seq[letra];
    const id = `${letra}-${String(n).padStart(6, "0")}`;
    estado.missoes[id] = { ...p, id, origem: "auto", status: "pendente", responsavel: "", obs: "", criadaEm: agora, atualizadoEm: agora, concluidaEm: null, motivoCancelamento: "" };
    existentes.add(p.chave);
    cont[p.tipo]++;
    mudou = true;
  }

  // 3) poda: fechadas há mais de 90 dias
  for (const m of Object.values(estado.missoes)) {
    if (!ABERTA(m.status) && Date.parse(agora) - Date.parse(m.atualizadoEm) > 90 * DIA) { delete estado.missoes[m.id]; mudou = true; }
  }
  return mudou;
}

/* ------------------------------------------------------------------- alertas */

export function alertasDoEstado(ctx: Contexto, missoes: Missao[], multiPi: number, agora: string): Alerta[] {
  const out: Alerta[] = [];
  const abertas = missoes.filter((m) => ABERTA(m.status));
  const add = (a: Alerta) => out.push(a);

  if (!ctx.rm)
    add({ id: "sem-rm", nivel: "atencao", regra: "Missões automáticas dependem dos pedidos", titulo: "Sem planilha de pedidos (QTD/CXP)", detalhe: "Sem a caixa padrão e o histórico de fracionados não é possível gerar missões automáticas. Missões manuais continuam funcionando." });
  if (multiPi > 0)
    add({ id: "multi-pi", nivel: "info", regra: "1 PI por LOC", titulo: `${multiPi} LOCs FR com mais de um PI`, detalhe: "A regra de 1 PI por LOC está quebrada nestas LOCs (já considerando as missões de movimentação em andamento).", tipo: "movimentacao", total: multiPi });

  const porOrigem = new Map<string, { qtd: number; ids: string[]; livre: number }>();
  const stale: string[] = [], conflito: string[] = [], estouro: string[] = [], paradas: string[] = [], foraRegra: string[] = [];
  for (const m of abertas) {
    const livre = m.tipo === "recompletamento" && m.idQuant ? (ctx.livrePorId.get(m.idQuant) ?? 0) : (ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.de)}`) ?? 0);
    const kO = `${m.pi}|${chaveLoc(m.de)}|${m.idQuant}`;
    const po = porOrigem.get(kO) ?? { qtd: 0, ids: [], livre };
    po.qtd += m.qtd; po.ids.push(m.id); porOrigem.set(kO, po);
    if (livre < m.qtd - EPS) stale.push(`${m.id} · ${m.pi} em ${m.de.dep} ${m.de.end}: saldo livre ${fmt(livre)} < ${fmt(m.qtd)}`);
    const ocup = ctx.ocupFr.get(chaveLoc(m.para)) ?? new Set<string>();
    const outros = [...ocup].filter((p) => p !== m.pi);
    // só quebra a regra se a missão LEVA o PI para uma LOC onde ele ainda não estava
    if (outros.length && !ocup.has(m.pi)) conflito.push(`${m.id} · destino ${m.para.dep} ${m.para.end} também tem ${outros.slice(0, 3).join(", ")}`);
    const emDest = [...ctx.locsFr.get(m.pi) ?? []].find((x) => chaveLoc(x) === chaveLoc(m.para))?.qtd ?? 0;
    const cap = capacidadeUn(ctx, m.pi);
    if (emDest + m.qtd > cap + EPS) estouro.push(`${m.id} · ${m.pi}: ${fmt(emDest + m.qtd)} un no destino > capacidade ${fmt(cap)}`);
    const idade = Date.parse(agora) - Date.parse(m.atualizadoEm);
    if ((m.status === "pendente" && idade > 2 * DIA) || (m.status === "em_execucao" && idade > 1 * DIA)) paradas.push(`${m.id} · ${m.status === "pendente" ? "pendente" : "em execução"} há ${Math.floor(idade / DIA)} dia(s)`);
    if (ctx.est.get(m.pi)?.noP04) foraRegra.push(`${m.id} · ${m.pi} tem saldo no P04 (fora das regras de reposição)`);
  }
  const over = [...porOrigem.values()].filter((x) => x.qtd > x.livre + EPS).map((x) => `${x.ids.join(", ")}: ${fmt(x.qtd)} un pedidas para ${fmt(x.livre)} livres`);
  const mk = (id: string, nivel: Alerta["nivel"], regra: string, titulo: string, detalhe: string, lista: string[], tipo?: TipoMissao) => {
    if (lista.length) add({ id, nivel, regra, titulo, detalhe, total: lista.length, exemplos: lista.slice(0, 8), tipo });
  };
  mk("origem-sem-saldo", "critico", "A origem precisa ter o saldo da missão", "Missão aberta com origem sem saldo livre", "O saldo livre na origem é menor que a quantidade da missão (já foi movido, bloqueado ou a planilha mudou).", stale);
  mk("overbooking", "critico", "Uma origem não pode ser prometida duas vezes", "Mais de uma missão aberta consome o mesmo estoque além do disponível", "A soma das missões abertas sobre a mesma origem passa do saldo livre.", over);
  mk("destino-misturado", "atencao", "1 PI por LOC", "Missão leva o PI para uma LOC que já tem outro PI", "Executar a missão quebra a regra de 1 PI por LOC.", conflito);
  mk("destino-capacidade", "atencao", "Capacidade da LOC", "Missão ultrapassa a capacidade da LOC de destino", "Saldo no destino + missão passa de caixas por LOC × caixa padrão.", estouro);
  mk("missao-parada", "atencao", "Missões devem andar", "Missão parada", "Pendente há mais de 2 dias ou em execução há mais de 1 dia sem atualização.", paradas);
  mk("fora-regra", "atencao", "PIs com saldo no P04 ficam fora", "Missão aberta de PI que tem saldo no P04", "A regra de reposição desconsidera PIs com saldo no P04.", foraRegra);

  // Recompletamento concluído, planilha já atualizada depois, e o FR continua abaixo do mínimo
  const recentes = missoes.filter((m) => m.tipo === "recompletamento" && m.status === "concluida" && m.concluidaEm && m.concluidaEm <= ctx.estoqueEm && Date.parse(agora) - Date.parse(m.concluidaEm) < 3 * DIA);
  const falhou = new Set<string>();
  for (const m of recentes) {
    const d = ctx.demanda.get(m.pi);
    if (d && (ctx.est.get(m.pi)?.fr ?? 0) < ctx.params.minCaixasFr * d.cxp - EPS) falhou.add(`${m.id} · ${m.pi} segue com FR abaixo do mínimo após a conclusão`);
  }
  mk("concluida-sem-efeito", "critico", "Missão concluída deve resolver a condição", "Recompletamento concluído, mas o FR continua abaixo do mínimo", "A planilha de estoque já foi atualizada depois da conclusão e o saldo não subiu: possível erro de execução ou de endereço.", [...falhou], "recompletamento");
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
  const cxp = ctx.demanda.get(e.pi)?.cxp;
  let qtd = Number(e.qtd) || 0;
  if (e.tipo === "recompletamento" && Number(e.caixas) > 0) {
    if (cxp) qtd = Number(e.caixas) * cxp; else if (!qtd) erro("Caixa padrão deste PI não conhecida: informe a quantidade em unidades.");
  }
  if (!e.pi) erro("Informe o PI.");
  else if (!ctx.dados.produtos[e.pi]) erro(`PI ${e.pi} não existe na planilha de estoque.`);
  if (!(qtd > 0)) erro("Informe uma quantidade maior que zero.");
  for (const [nome, l] of [["origem", e.de], ["destino", e.para]] as const) if (!l.dep || !l.end) erro(`Informe o paiol e o endereço de ${nome}.`);
  if (e.de.dep && e.para.dep && chaveLoc(e.de) === chaveLoc(e.para)) erro("Origem e destino são a mesma LOC.");
  if (av.some((a) => a.nivel === "erro")) return { avisos: av, qtd };

  const ef = efetivas(missoes, ctx.estoqueEm);
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
    if (areasPara && !areasPara.has("FR")) aviso("O destino não é uma LOC FR.");
  }
  const ocupDest = ctx.ocupFr.get(chaveLoc(e.para)) ?? new Set<string>();
  const outros = [...ocupDest].filter((p) => p !== e.pi);
  if (outros.length && !ocupDest.has(e.pi)) aviso(`O destino já tem outro PI (${outros.slice(0, 3).join(", ")}): a regra de 1 PI por LOC será quebrada.`);
  const cap = capacidadeUn(ctx, e.pi);
  const noDest = ctx.locsFr.get(e.pi)?.find((x) => chaveLoc(x) === chaveLoc(e.para))?.qtd ?? 0;
  if (Number.isFinite(cap) && noDest + qtd > cap + EPS) aviso(`O destino passaria de ${fmt(cap)} un (capacidade da LOC): ficaria com ${fmt(noDest + qtd)}.`);
  if (ctx.est.get(e.pi)?.noP04) aviso("Este PI tem saldo no P04, que fica fora das regras de reposição.");
  return { avisos: av, qtd };
}
