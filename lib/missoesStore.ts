import { atualizarJson, lerJson } from "./blobJson";
import { ARQUIVO_MISSOES } from "./config";
import { obterEstoque, obterRm } from "./fontes";
import {
  ABERTA, PARAMS_PADRAO_MISSOES, STATUS_MISSAO, type Alerta, type AvisoValidacao, type EstadoMissoes, type Local, type Missao, type Parametros, type StatusMissao,
} from "./missoes";
import {
  alertasDoEstado, efetivas, gerarMovimentacao, gerarRecompletamento, montarContexto, sincronizar, validarManual, type EntradaManual,
} from "./missoesLogica";

const vazio = (): EstadoMissoes => ({ versao: 1, seq: { R: 0, A: 0 }, missoes: {}, params: { ...PARAMS_PADRAO_MISSOES } });
const mesclar = (p: Partial<Parametros> | undefined): Parametros => ({ ...PARAMS_PADRAO_MISSOES, ...(p ?? {}) });

export interface RespostaMissoes {
  missoes: Missao[];
  params: Parametros;
  alertas: Alerta[];
  rmErro: string | null;
  estoqueEm: string | null;
  geradoEm: string;
}

/** Carrega o estado, gera/atualiza as missões automáticas e devolve tudo com os alertas. */
export async function sincronizarEListar(): Promise<RespostaMissoes> {
  const dados = await obterEstoque();
  const { rm, erro: rmErro } = await obterRm();
  const agora = new Date().toISOString();

  const estado = await atualizarJson(ARQUIVO_MISSOES, vazio, (e) => {
    e.params = mesclar(e.params);
    if (!rm) return false; // sem pedidos não há como gerar missões automáticas
    const ctx = montarContexto(dados, rm, e.params);
    const efet = efetivas(Object.values(e.missoes), ctx.estoqueEm);
    const propostas = [...gerarRecompletamento(ctx, efet).propostas, ...gerarMovimentacao(ctx, efet).propostas];
    return sincronizar(e, propostas, ctx, agora);
  });
  estado.params = mesclar(estado.params);

  // Segunda passada, já com as missões criadas, só para os alertas
  const ctx = montarContexto(dados, rm, estado.params);
  const lista = Object.values(estado.missoes);
  const efet = efetivas(lista, ctx.estoqueEm);
  const alertas: Alerta[] = [];
  let multiPi = 0;
  if (rm) {
    alertas.push(...gerarRecompletamento(ctx, efet).alertas);
    const mv = gerarMovimentacao(ctx, efet);
    alertas.push(...mv.alertas);
    multiPi = mv.multiPi;
  }
  alertas.push(...alertasDoEstado(ctx, lista, multiPi, agora));
  const peso = { critico: 0, atencao: 1, info: 2 } as const;
  alertas.sort((a, b) => peso[a.nivel] - peso[b.nivel]);

  return {
    missoes: lista.sort((a, b) => a.prioridade - b.prioridade || b.criadaEm.localeCompare(a.criadaEm)),
    params: estado.params, alertas, rmErro, estoqueEm: dados.atualizadoEm, geradoEm: agora,
  };
}

/* ------------------------------------------------------------------- edições */

export async function alterarMissao(id: string, campos: { status?: StatusMissao; responsavel?: string; obs?: string; prioridade?: 1 | 2 | 3 }): Promise<Missao> {
  if (campos.status !== undefined && !STATUS_MISSAO.some((s) => s.id === campos.status)) throw new Error("Status inválido");
  if (campos.prioridade !== undefined && ![1, 2, 3].includes(campos.prioridade)) throw new Error("Prioridade inválida");
  let editada: Missao | null = null;
  await atualizarJson(ARQUIVO_MISSOES, vazio, (e) => {
    const m = e.missoes[id];
    if (!m) return false;
    const agora = new Date().toISOString();
    if (campos.status !== undefined && campos.status !== m.status) {
      m.status = campos.status;
      m.concluidaEm = campos.status === "concluida" ? agora : null;
      if (campos.status === "cancelada" && !m.motivoCancelamento) m.motivoCancelamento = "Cancelada manualmente";
      if (campos.status !== "cancelada") m.motivoCancelamento = "";
    }
    if (campos.responsavel !== undefined) m.responsavel = String(campos.responsavel).slice(0, 80);
    if (campos.obs !== undefined) m.obs = String(campos.obs).slice(0, 600);
    if (campos.prioridade !== undefined) m.prioridade = campos.prioridade;
    m.atualizadoEm = agora;
    editada = m;
    return true;
  });
  if (!editada) throw new Error("Missão não encontrada. Recarregue a página.");
  return editada;
}

export class AvisosError extends Error {
  constructor(public avisos: AvisoValidacao[], public bloqueante: boolean) { super("validação"); }
}

export async function criarManual(entrada: EntradaManual, forcar: boolean): Promise<Missao> {
  const limpa = (l: Local): Local => ({ dep: String(l?.dep ?? "").trim().toUpperCase(), end: String(l?.end ?? "").trim().toUpperCase() });
  const e: EntradaManual = {
    tipo: entrada.tipo === "movimentacao" ? "movimentacao" : "recompletamento",
    pi: String(entrada.pi ?? "").trim(), qtd: Number(entrada.qtd) || undefined, caixas: Number(entrada.caixas) || undefined,
    de: limpa(entrada.de), para: limpa(entrada.para),
    prioridade: ([1, 2, 3] as const).find((p) => p === Number(entrada.prioridade)) ?? 2,
    responsavel: String(entrada.responsavel ?? "").slice(0, 80), obs: String(entrada.obs ?? "").slice(0, 600),
  };
  const dados = await obterEstoque();
  const { rm } = await obterRm();
  const { dados: atual } = await lerJson(ARQUIVO_MISSOES, vazio);
  const ctx = montarContexto(dados, rm, mesclar(atual.params));
  const { avisos, qtd } = validarManual(e, ctx, Object.values(atual.missoes));
  if (avisos.some((a) => a.nivel === "erro")) throw new AvisosError(avisos, true);
  if (avisos.length && !forcar) throw new AvisosError(avisos, false);

  const linhaOrigem = e.tipo === "recompletamento"
    ? (ctx.linhasSc.get(e.pi) ?? []).filter((l) => l.dep === e.de.dep && l.end === e.de.end)
    : [];
  const unica = linhaOrigem.length === 1 ? linhaOrigem[0] : null;
  let criada: Missao | null = null;
  await atualizarJson(ARQUIVO_MISSOES, vazio, (est) => {
    const letra = e.tipo === "recompletamento" ? "R" : "A";
    const id = `${letra}-${String(++est.seq[letra]).padStart(6, "0")}`;
    const agora = new Date().toISOString();
    const cxp = ctx.demanda.get(e.pi)?.cxp;
    criada = {
      id, tipo: e.tipo, origem: "manual", status: "pendente", prioridade: e.prioridade ?? 2, pi: e.pi, desc: ctx.produtoDesc(e.pi), qtd,
      caixas: e.tipo === "recompletamento" && cxp ? Math.round((qtd / cxp) * 100) / 100 : null, de: e.de, para: e.para,
      lote: unica?.lote ?? "", validade: unica?.val ?? "", idQuant: unica?.id ?? "", motivo: "Missão manual", chave: "",
      responsavel: e.responsavel ?? "", obs: e.obs ?? "", criadaEm: agora, atualizadoEm: agora, concluidaEm: null, motivoCancelamento: "",
    };
    est.missoes[id] = criada;
    return true;
  });
  return criada!;
}

export async function salvarParametros(p: Partial<Parametros>): Promise<Parametros> {
  const n = (v: unknown, min: number, max: number, def: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
  const final = await atualizarJson(ARQUIVO_MISSOES, vazio, (e) => {
    const a = mesclar(e.params);
    if (p.diasAlvo !== undefined) a.diasAlvo = n(p.diasAlvo, 1, 60, a.diasAlvo);
    if (p.caixasLoc !== undefined) a.caixasLoc = n(p.caixasLoc, 1, 500, a.caixasLoc);
    if (p.minCaixasFr !== undefined) a.minCaixasFr = n(p.minCaixasFr, 1, 50, a.minCaixasFr);
    if (p.janela !== undefined) a.janela = n(p.janela, 0, 3650, a.janela);
    if (p.limiteRecomp !== undefined) a.limiteRecomp = n(p.limiteRecomp, 0, 1000, a.limiteRecomp);
    if (p.limiteMov !== undefined) a.limiteMov = n(p.limiteMov, 0, 1000, a.limiteMov);
    if (p.caixasPorPi !== undefined) {
      a.caixasPorPi = Object.fromEntries(Object.entries(p.caixasPorPi).filter(([k, v]) => k && Number(v) > 0).map(([k, v]) => [String(k).trim(), Number(v)]).slice(0, 5000));
    }
    if (p.locsVazias !== undefined) {
      const vistos = new Set<string>();
      a.locsVazias = (p.locsVazias as Local[]).map((l) => ({ dep: String(l?.dep ?? "").trim().toUpperCase(), end: String(l?.end ?? "").trim().toUpperCase() }))
        .filter((l) => l.dep && l.end && !vistos.has(l.dep + "|" + l.end) && vistos.add(l.dep + "|" + l.end)).slice(0, 5000);
    }
    e.params = a;
    return true;
  });
  return mesclar(final.params);
}

export { ABERTA };
