import { NIVEL_SC_REPOSICAO } from "./config";
import { montarLayout } from "./layoutFr";
import type { Missao } from "./missoes";
import type { Contexto } from "./missoesLogica";

/**
 * Auditoria independente do plano de missões. Não reaproveita as decisões do planejador: parte da planilha de estoque e executa
 * as missões onda a onda (quem está na onda 2 só enxerga o que a onda 1 já fez), conferindo cada uma contra os limites e parâmetros.
 *
 * Regras conferidas:
 *  PAIOL       movimentação não atravessa paiol
 *  CX-FECHADA  devolução ao SC é sempre em caixas fechadas (múltiplo da CXP, que precisa ser conhecida)
 *  SC-LIMITE   LOC de SC que recebe caixas fica com no máximo `maxCaixasSc` (calçado `maxCaixasScCalcado`) caixas somando TODOS os PIs da LOC
 *  SC-NIVEL    caixas soltas (devolução do FR, consolidação) só vão para LOC de SC da altura de reposição (02); palete só desce para a altura 02
 *  SC-VAZIA    palete descido/desmisturado só vai para LOC de SC vazia
 *  SC-1PI      ao final de todas as ondas, a LOC de SC que recebeu algo tem um PI só (mistura só vale como provisória)
 *  ORIGEM      a origem (FR ou SC) tem o saldo livre da missão quando ela roda (considerando só o que as ondas anteriores fizeram)
 *  FR-LIMITE   o PI no destino FR fica com no máximo `maxCaixas` caixas inteiras (calçado `maxCaixasCalcado`; LOC dividida: `caixasZona`)
 *  FR-1PI      destino FR sem outro PI (LOC dividida: no máximo 2 PIs); o outro só some quando a onda anterior o tirar
 */

export interface Violacao { id: string; regra: string; detalhe: string }
export interface ResultadoAuditoria {
  conferidas: number;
  checagens: Record<string, number>; // quantas vezes cada regra foi conferida
  violacoes: Violacao[];
}

const EPS = 1e-6;
const chave = (dep: string, end: string) => `${dep}|${end}`;
const fmt = (n: number) => String(Math.round(n * 100) / 100).replace(".", ",");
const nivelDe = (end: string) => Number(end.split("-")[2]) || 0;

export function auditar(ctx: Contexto, missoes: Missao[], compartilhadas: ReadonlySet<string> = new Set(), locsFr: ReadonlySet<string> = new Set()): ResultadoAuditoria {
  const { params } = ctx;
  const checagens: Record<string, number> = { PAIOL: 0, "CX-FECHADA": 0, "SC-LIMITE": 0, "SC-NIVEL": 0, "SC-VAZIA": 0, "SC-1PI": 0, ORIGEM: 0, "FR-LIMITE": 0, "FR-1PI": 0 };
  const violacoes: Violacao[] = [];
  const viola = (m: Missao, regra: string, detalhe: string) => violacoes.push({ id: m.id, regra, detalhe });
  const conta = (r: string) => { checagens[r]++; };

  // estado FR: LOC → PI → { qtd (disponível livre + bloqueado), bloq }
  const fr = new Map<string, Map<string, { qtd: number; bloq: number }>>();
  for (const l of montarLayout(ctx.dados, true).locs) {
    const mp = new Map<string, { qtd: number; bloq: number }>();
    for (const it of l.itens) mp.set(it.pi, { qtd: it.qtd, bloq: it.bloq });
    fr.set(l.loc, mp);
  }
  // estado SC: LOC → PI → { qtd (total, todos os status), livre (movimentável) }
  const sc = new Map<string, Map<string, { qtd: number; livre: number }>>();
  for (const l of ctx.dados.linhas) {
    if (l.area !== "SC" || ctx.dados.escopos[l.dep] !== "estoque" || !(l.total > 0 || l.disp > 0)) continue;
    const k = chave(l.dep, l.end);
    const mp = sc.get(k) ?? sc.set(k, new Map()).get(k)!;
    const it = mp.get(l.pi) ?? mp.set(l.pi, { qtd: 0, livre: 0 }).get(l.pi)!;
    it.qtd += l.total; if (l.livre) it.livre += l.disp;
  }
  const caixasSc = (k: string): number => { // todos os PIs; Infinity se algum não tem caixa padrão
    let v = 0;
    for (const [pi, it] of sc.get(k) ?? []) { if (it.qtd <= EPS) continue; const c = ctx.cxpDe(pi); if (!c) return Infinity; v += it.qtd / c; }
    return v;
  };
  const pisSc = (k: string) => [...(sc.get(k) ?? [])].filter(([, it]) => it.qtd > EPS).map(([pi]) => pi);
  const ehFr = (k: string) => fr.has(k) || !!ctx.areasLoc.get(k)?.has("FR") || params.locsVazias.some((v) => chave(v.dep, v.end) === k) || compartilhadas.has(k) || locsFr.has(k);
  const tocadas = new Map<string, Missao>(); // LOC SC → última missão que chegou nela

  const ordenadas = [...missoes].sort((a, b) => a.onda - b.onda || (a.id < b.id ? -1 : 1));
  const ondas = [...new Set(ordenadas.map((m) => m.onda))].sort((a, b) => a - b);

  for (const onda of ondas) {
    const dessa = ordenadas.filter((m) => m.onda === onda);
    // efeitos da onda só valem para a próxima; dentro da onda conta o que já saiu (conservador) e as chegadas ainda não contam para a origem
    const saiu = new Map<string, number>(); // "pi|loc" → saída acumulada nesta onda (FR ou SC)
    const chegou = new Map<string, number>(); // "pi|loc" → chegada acumulada nesta onda
    const chegouSc = new Map<string, Set<string>>(); // LOC SC → PIs que chegam nesta onda
    const chegadasCx = new Map<string, number>(); // LOC SC → caixas que chegam nesta onda
    const efeitos: (() => void)[] = [];

    for (const m of dessa) {
      const de = chave(m.de.dep, m.de.end), para = chave(m.para.dep, m.para.end);
      const cxp = ctx.cxpDe(m.pi);
      const lim = ctx.limites(m.pi);
      const calcado = ctx.ehCalcado(m.pi);
      const scParaSc = m.tipo === "movimentacao" && !!m.sub;
      const origemSc = m.tipo === "recompletamento" || scParaSc;

      // --- origem
      conta("ORIGEM");
      if (origemSc) {
        const livre = (sc.get(de)?.get(m.pi)?.livre ?? 0) - (saiu.get(`${m.pi}|${de}`) ?? 0);
        if (livre < m.qtd - EPS) viola(m, "ORIGEM", `SC ${m.de.end} só terá ${fmt(Math.max(0, livre))} un livres do PI quando a missão rodar (pede ${fmt(m.qtd)}).`);
        saiu.set(`${m.pi}|${de}`, (saiu.get(`${m.pi}|${de}`) ?? 0) + m.qtd);
      } else {
        const it = fr.get(de)?.get(m.pi);
        const ja = saiu.get(`${m.pi}|${de}`) ?? 0;
        const livre = (it ? it.qtd - it.bloq : 0) - ja;
        if (livre < m.qtd - EPS) viola(m, "ORIGEM", `A LOC ${m.de.end} só terá ${fmt(Math.max(0, livre))} un livres do PI quando a missão rodar (pede ${fmt(m.qtd)}).`);
        saiu.set(`${m.pi}|${de}`, ja + m.qtd);
      }
      if (m.tipo === "recompletamento" && cxp) { conta("CX-FECHADA"); if (Math.abs(m.qtd / cxp - Math.round(m.qtd / cxp)) > EPS) viola(m, "CX-FECHADA", `Recompletamento de ${fmt(m.qtd)} un não é múltiplo da caixa padrão (${fmt(cxp)}).`); }

      // --- paiol
      if (m.tipo === "movimentacao") { conta("PAIOL"); if (m.de.dep !== m.para.dep) viola(m, "PAIOL", `Atravessa paiol: ${m.de.dep} → ${m.para.dep}.`); }

      // --- destino
      const destinoFr = m.tipo === "recompletamento" || (!scParaSc && ehFr(para));
      let destinoSc = false;
      if (destinoFr) {
        const compart = compartilhadas.has(para);
        const loc = fr.get(para);
        const ja = chegou.get(`${m.pi}|${para}`) ?? 0;
        conta("FR-LIMITE");
        if (lim) {
          const cap = compart ? Math.min(lim.maxCx, params.caixasZona) : lim.maxCx;
          const apos = (loc?.get(m.pi)?.qtd ?? 0) + ja + m.qtd; // chegadas contam; saídas desta onda não (ainda não aconteceram)
          const inteiras = Math.floor(apos / lim.cxp + EPS);
          if (inteiras > cap) viola(m, "FR-LIMITE", `A LOC ${m.para.end} ficaria com ${inteiras} caixa(s) inteira(s) do PI (${fmt(apos)} un), acima do máximo de ${cap}${calcado ? " (calçado)" : ""}.`);
        }
        const troca = m.nota.startsWith("Troca entre duas LOCs"); // A→B e B→A feitas juntas: o "outro PI" é o que está saindo na troca
        if (!troca) conta("FR-1PI");
        const outros = [...(loc?.entries() ?? [])].filter(([pi, it]) => pi !== m.pi && it.qtd > EPS).map(([pi]) => pi);
        const outrosChegando = [...chegou.keys()].filter((x) => x.endsWith(`|${para}`) && !x.startsWith(`${m.pi}|`)).length;
        const limitePis = compart ? 1 : 0; // quantos OUTROS PIs a LOC pode ter
        if (!troca && outros.length + outrosChegando > limitePis) viola(m, "FR-1PI", `A LOC ${m.para.end} ainda tem outro PI (${outros.slice(0, 3).join(", ")}) quando a missão roda${compart ? " (já dividida por 2 PIs)" : " (1 PI por LOC)"}.`);
        chegou.set(`${m.pi}|${para}`, ja + m.qtd);
      } else {
        destinoSc = true;
        const limSc = calcado ? params.maxCaixasScCalcado : params.maxCaixasSc;
        const nivelPara = nivelDe(m.para.end);
        const outros = pisSc(para).filter((p) => p !== m.pi);
        const chegando = [...(chegouSc.get(para) ?? [])].filter((p) => p !== m.pi);
        if (!scParaSc) {
          // FR → SC (devolução em caixas fechadas)
          conta("CX-FECHADA");
          if (!cxp) viola(m, "CX-FECHADA", "Caixa padrão (CXP) do PI desconhecida: não dá para garantir caixas fechadas.");
          else if (Math.abs(m.qtd / cxp - Math.round(m.qtd / cxp)) > EPS) viola(m, "CX-FECHADA", `Devolução de ${fmt(m.qtd)} un não é múltiplo da caixa padrão (${fmt(cxp)}).`);
          if (ctx.areasLoc.get(para)?.has("FR")) viola(m, "SC-LIMITE", `A LOC ${m.para.end} é de FR, não de SC.`);
        }
        const propriaSo = m.sub === "desmisturar" && outros.length === 0 && chegando.length === 0 && (sc.get(para)?.get(m.pi)?.qtd ?? 0) > EPS; // junta no SC de reposição do próprio PI
        if ((m.sub === "descer" || m.sub === "desmisturar") && !propriaSo) {
          conta("SC-VAZIA");
          if (outros.length || chegando.length || (sc.get(para)?.get(m.pi)?.qtd ?? 0) > EPS) viola(m, "SC-VAZIA", `A LOC SC ${m.para.end} não está vazia quando o palete chega (${[...outros, ...chegando].slice(0, 3).join(", ") || m.pi}).`);
        } else {
          // caixas soltas: altura de reposição e capacidade (provisoriamente pode ter outro PI; a mistura é conferida no fim)
          conta("SC-NIVEL");
          if (nivelPara !== NIVEL_SC_REPOSICAO) viola(m, "SC-NIVEL", `Caixas soltas só vão para a altura ${String(NIVEL_SC_REPOSICAO).padStart(2, "0")} do SC; ${m.para.end} é altura ${String(nivelPara).padStart(2, "0")} (palete fechado).`);
          conta("SC-LIMITE");
          const atual = caixasSc(para);
          const apos = atual + (chegadasCx.get(para) ?? 0) + (cxp ? m.qtd / cxp : 0); // + o que já chegou nesta onda
          if (!Number.isFinite(atual)) viola(m, "SC-LIMITE", `A LOC SC ${m.para.end} tem item sem caixa padrão conhecida: capacidade não verificável (limite ${limSc}).`);
          else if (apos > limSc + EPS) viola(m, "SC-LIMITE", `A LOC SC ${m.para.end} ficaria com ${fmt(apos)} caixa(s) (já tem ${fmt(atual)}), acima do limite de ${limSc}${calcado ? " (calçado)" : ""}.`);
        }
        if (m.sub === "descer") { conta("SC-NIVEL"); if (nivelPara !== NIVEL_SC_REPOSICAO || nivelDe(m.de.end) <= NIVEL_SC_REPOSICAO) viola(m, "SC-NIVEL", `Descer palete: de altura mais alta (${m.de.end}) para a altura 02 (${m.para.end}).`); }
        (chegouSc.get(para) ?? chegouSc.set(para, new Set()).get(para)!).add(m.pi);
        chegadasCx.set(para, (chegadasCx.get(para) ?? 0) + (cxp ? m.qtd / cxp : 0));
        tocadas.set(para, m);
      }

      // efeitos aplicados no fim da onda
      efeitos.push(() => {
        if (origemSc) {
          const o = sc.get(de)?.get(m.pi);
          if (o) { o.qtd -= m.qtd; o.livre -= m.qtd; if (o.qtd <= EPS) sc.get(de)!.delete(m.pi); }
        } else if (m.tipo === "movimentacao") {
          const o = fr.get(de)?.get(m.pi);
          if (o) { o.qtd -= m.qtd; if (o.qtd <= EPS && o.bloq <= EPS) fr.get(de)!.delete(m.pi); }
        }
        if (destinoFr) {
          let l = fr.get(para); if (!l) fr.set(para, (l = new Map()));
          const it = l.get(m.pi); if (it) it.qtd += m.qtd; else l.set(m.pi, { qtd: m.qtd, bloq: 0 });
        } else if (destinoSc) {
          let l = sc.get(para); if (!l) sc.set(para, (l = new Map()));
          const it = l.get(m.pi); if (it) { it.qtd += m.qtd; it.livre += m.qtd; } else l.set(m.pi, { qtd: m.qtd, livre: m.qtd });
        }
      });
    }
    for (const e of efeitos) e();
  }

  // estado final: LOC de SC que recebeu algo tem um PI só (mistura só vale como provisória)
  for (const [k, m] of tocadas) {
    conta("SC-1PI");
    const pis = pisSc(k);
    if (pis.length > 1) viola(m, "SC-1PI", `A LOC SC ${m.para.end} termina com mais de um PI (${pis.slice(0, 3).join(", ")}): a mistura só pode ser provisória.`);
  }
  return { conferidas: missoes.length, checagens, violacoes };
}
