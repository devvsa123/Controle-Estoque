import { montarLayout } from "./layoutFr";
import type { Missao } from "./missoes";
import type { Contexto } from "./missoesLogica";

/**
 * Auditoria independente do plano de missões. Não reaproveita as decisões do planejador: parte da planilha de estoque e executa
 * as missões onda a onda (quem está na onda 2 só enxerga o que a onda 1 já fez), conferindo cada uma contra os limites e parâmetros.
 *
 * Regras conferidas:
 *  PAIOL     movimentação não atravessa paiol
 *  CX-FECHADA  devolução ao SC é sempre em caixas fechadas (múltiplo da CXP, que precisa ser conhecida)
 *  SC-LIMITE   LOC de destino em SC fica com no máximo `maxCaixasSc` (calçado `maxCaixasScCalcado`) caixas somando TODOS os PIs da LOC
 *  ORIGEM      a origem tem o saldo livre da missão quando ela roda (considerando só o que as ondas anteriores fizeram)
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

export function auditar(ctx: Contexto, missoes: Missao[], compartilhadas: ReadonlySet<string> = new Set()): ResultadoAuditoria {
  const { params } = ctx;
  const checagens: Record<string, number> = { PAIOL: 0, "CX-FECHADA": 0, "SC-LIMITE": 0, ORIGEM: 0, "FR-LIMITE": 0, "FR-1PI": 0 };
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
  const ehFr = (k: string) => fr.has(k) || !!ctx.areasLoc.get(k)?.has("FR") || params.locsVazias.some((v) => chave(v.dep, v.end) === k) || compartilhadas.has(k);
  const scCx = new Map<string, number>(); // caixas em LOC SC (todos os PIs)
  const caixasSc = (k: string) => { let v = scCx.get(k); if (v === undefined) { v = ctx.scCaixas(k); scCx.set(k, v); } return v; };
  const livreSc = new Map<string, number>(); // saldo livre de SC por ID_QUANT/PI-LOC já prometido
  const usadoSc = (id: string) => livreSc.get(id) ?? 0;

  const ordenadas = [...missoes].sort((a, b) => a.onda - b.onda || (a.id < b.id ? -1 : 1));
  const ondas = [...new Set(ordenadas.map((m) => m.onda))].sort((a, b) => a - b);

  for (const onda of ondas) {
    const dessa = ordenadas.filter((m) => m.onda === onda);
    // efeitos da onda só valem para a próxima; dentro da onda conta o que já saiu (conservador) e as chegadas ainda não contam para a origem
    const saiu = new Map<string, number>(); // "pi|loc" → saída acumulada nesta onda
    const chegou = new Map<string, number>(); // "pi|loc" → chegada acumulada nesta onda
    const efeitos: (() => void)[] = [];

    for (const m of dessa) {
      const de = chave(m.de.dep, m.de.end), para = chave(m.para.dep, m.para.end);
      const cxp = ctx.cxpDe(m.pi);
      const lim = ctx.limites(m.pi);
      const calcado = ctx.ehCalcado(m.pi);

      // --- origem
      if (m.tipo === "recompletamento") {
        conta("ORIGEM");
        const livre = (m.idQuant ? ctx.livrePorId.get(m.idQuant) : ctx.livreLoc.get(`${m.pi}|${de}`)) ?? 0;
        const id = m.idQuant || `${m.pi}|${de}`;
        if (livre - usadoSc(id) < m.qtd - EPS) viola(m, "ORIGEM", `SC ${m.de.end} tem ${fmt(livre - usadoSc(id))} un livres e a missão pede ${fmt(m.qtd)}.`);
        livreSc.set(id, usadoSc(id) + m.qtd);
        if (cxp) { conta("CX-FECHADA"); if (Math.abs(m.qtd / cxp - Math.round(m.qtd / cxp)) > EPS) viola(m, "CX-FECHADA", `Recompletamento de ${fmt(m.qtd)} un não é múltiplo da caixa padrão (${fmt(cxp)}).`); }
        efeitos.push(() => { scCx.set(de, Math.max(0, caixasSc(de) - (cxp ? m.qtd / cxp : 0))); });
      } else {
        conta("ORIGEM");
        const it = fr.get(de)?.get(m.pi);
        const ja = saiu.get(`${m.pi}|${de}`) ?? 0;
        const livre = (it ? it.qtd - it.bloq : 0) - ja;
        if (livre < m.qtd - EPS) viola(m, "ORIGEM", `A LOC ${m.de.end} só terá ${fmt(Math.max(0, livre))} un livres do PI quando a missão rodar (pede ${fmt(m.qtd)}).`);
        saiu.set(`${m.pi}|${de}`, ja + m.qtd);
      }

      // --- paiol
      if (m.tipo === "movimentacao") { conta("PAIOL"); if (m.de.dep !== m.para.dep) viola(m, "PAIOL", `Atravessa paiol: ${m.de.dep} → ${m.para.dep}.`); }

      // --- destino
      const destinoFr = m.tipo === "recompletamento" || ehFr(para);
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
        // FR → SC
        conta("CX-FECHADA");
        if (!cxp) viola(m, "CX-FECHADA", "Caixa padrão (CXP) do PI desconhecida: não dá para garantir caixas fechadas.");
        else if (Math.abs(m.qtd / cxp - Math.round(m.qtd / cxp)) > EPS) viola(m, "CX-FECHADA", `Devolução de ${fmt(m.qtd)} un não é múltiplo da caixa padrão (${fmt(cxp)}).`);
        conta("SC-LIMITE");
        const limSc = calcado ? params.maxCaixasScCalcado : params.maxCaixasSc;
        const atual = caixasSc(para);
        const apos = atual + (cxp ? m.qtd / cxp : 0);
        if (!Number.isFinite(atual)) viola(m, "SC-LIMITE", `A LOC SC ${m.para.end} tem item sem caixa padrão conhecida: capacidade não verificável (limite ${limSc}).`);
        else if (apos > limSc + EPS) viola(m, "SC-LIMITE", `A LOC SC ${m.para.end} ficaria com ${fmt(apos)} caixa(s) (já tem ${fmt(atual)}), acima do limite de ${limSc}${calcado ? " (calçado)" : ""}.`);
        scCx.set(para, apos);
        if (ctx.areasLoc.get(para)?.has("FR")) viola(m, "SC-LIMITE", `A LOC ${m.para.end} é de FR, não de SC.`);
      }

      // efeitos aplicados no fim da onda
      efeitos.push(() => {
        if (m.tipo === "movimentacao") {
          const o = fr.get(de)?.get(m.pi);
          if (o) { o.qtd -= m.qtd; if (o.qtd <= EPS && o.bloq <= EPS) fr.get(de)!.delete(m.pi); }
        }
        if (destinoFr) {
          let l = fr.get(para); if (!l) fr.set(para, (l = new Map()));
          const it = l.get(m.pi); if (it) it.qtd += m.qtd; else l.set(m.pi, { qtd: m.qtd, bloq: 0 });
        }
      });
    }
    for (const e of efeitos) e();
  }
  return { conferidas: missoes.length, checagens, violacoes };
}
