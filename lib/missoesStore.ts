import { atualizarJson, lerJson } from "./blobJson";
import { ARQUIVO_MISSOES } from "./config";
import { obterEstoque, obterRm } from "./fontes";
import {
  ABERTA, EM_ANDAMENTO, PARAMS_PADRAO_MISSOES, STATUS_MISSAO, type Alerta, type AvisoValidacao, type Conformidade, type EstadoMissoes, type Local, type Missao, type Parametros, type StatusMissao,
} from "./missoes";
import {
  alertasDoEstado, chaveLoc, conformidade, criarMissoes, efetivas, montarContexto, planejar, validarManual, verificarEstado, type EntradaManual, type Plano,
} from "./missoesLogica";

const vazio = (): EstadoMissoes => ({ versao: 2, seq: { R: 0, A: 0 }, missoes: {}, params: { ...PARAMS_PADRAO_MISSOES }, casas: {}, zona: {} });
const mesclar = (p: Partial<Parametros> | undefined): Parametros => ({ ...PARAMS_PADRAO_MISSOES, ...(p ?? {}) });

export interface RespostaMissoes {
  missoes: Missao[];
  params: Parametros;
  alertas: Alerta[];
  conformidade: Conformidade | null;
  resumo: Plano["resumo"] | null;
  rmErro: string | null;
  estoqueEm: string | null;
  geradoEm: string;
}

/** Migra o estado da primeira versão (lógica por média de dias): missões automáticas antigas são encerradas. */
function migrar(e: EstadoMissoes, agora: string): boolean {
  if ((e as { versao: number }).versao === 2) return false;
  for (const m of Object.values(e.missoes)) {
    if (m.origem === "auto" && (m.status === "pendente" || m.status === "em_execucao")) {
      m.status = "cancelada"; m.motivoCancelamento = "Substituída pela nova lógica de endereçamento (mín./máx. de caixas por LOC)"; m.atualizadoEm = agora;
    }
    m.onda = m.onda ?? 1; m.verificadaEm = m.verificadaEm ?? null; m.nota = m.nota ?? ""; m.baseEm = m.baseEm ?? ""; m.baseOrigem = m.baseOrigem ?? 0; m.baseDestino = m.baseDestino ?? 0;
  }
  e.params = mesclar(undefined);
  (e as { versao: number }).versao = 2;
  return true;
}

/** Carrega o estado, verifica as missões contra a planilha, planeja o que falta e devolve tudo com os alertas. */
export async function sincronizarEListar(): Promise<RespostaMissoes> {
  const dados = await obterEstoque();
  const { rm, erro: rmErro } = await obterRm();
  const agora = new Date().toISOString();

  const estado = await atualizarJson(ARQUIVO_MISSOES, vazio, (e) => {
    const migrou = migrar(e, agora);
    let mudou = migrou;
    e.params = mesclar(e.params);
    const ctx = montarContexto(dados, rm, e.params);
    if (migrou) {
      // missões da versão anterior que seguem abertas (as manuais): a "foto" de base passa a ser a planilha atual
      for (const m of Object.values(e.missoes)) {
        if (!EM_ANDAMENTO(m.status)) continue;
        m.baseOrigem = ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.de)}`) ?? 0;
        m.baseDestino = ctx.livreLoc.get(`${m.pi}|${chaveLoc(m.para)}`) ?? 0;
        m.baseEm = ctx.estoqueEm;
      }
    }
    e.casas = e.casas ?? {}; e.zona = e.zona ?? {};
    // 1) conferir o que já foi feito (antes de planejar, para não contar duas vezes o que a planilha já mostra)
    if (verificarEstado(e, ctx, agora)) mudou = true;
    // 2) planejar o que falta, tratando as missões em andamento como já feitas
    const plano = rm ? planejar(ctx, efetivas(Object.values(e.missoes)), e.casas, e.zona) : null;
    if (plano && (JSON.stringify(plano.casas) !== JSON.stringify(e.casas) || JSON.stringify(plano.zona) !== JSON.stringify(e.zona))) { e.casas = plano.casas; e.zona = plano.zona; mudou = true; }
    // 3) criar as missões novas
    if (criarMissoes(e, plano, agora)) mudou = true;
    return mudou;
  });
  estado.params = mesclar(estado.params);

  // Segunda passada, já com as missões criadas, para os alertas e indicadores
  const ctx = montarContexto(dados, rm, estado.params);
  const lista = Object.values(estado.missoes);
  const conf = conformidade(ctx);
  const alertas: Alerta[] = [];
  let resumo: Plano["resumo"] | null = null;
  if (rm) {
    const plano = planejar(ctx, efetivas(lista), estado.casas ?? {}, estado.zona ?? {});
    alertas.push(...plano.alertas);
    resumo = plano.resumo;
  }
  alertas.push(...alertasDoEstado(ctx, lista, conf, agora));
  const peso = { critico: 0, atencao: 1, info: 2 } as const;
  alertas.sort((a, b) => peso[a.nivel] - peso[b.nivel]);

  return {
    missoes: lista.sort((a, b) => a.onda - b.onda || a.prioridade - b.prioridade || a.id.localeCompare(b.id)),
    params: estado.params, alertas, conformidade: conf, resumo, rmErro, estoqueEm: dados.atualizadoEm, geradoEm: agora,
  };
}

/* ------------------------------------------------------------------- edições */

/** Status que o usuário pode definir: concluída/divergente só a planilha define. */
const STATUS_MANUAIS: StatusMissao[] = ["pendente", "em_execucao", "feita", "cancelada"];

export async function alterarMissao(id: string, campos: { status?: StatusMissao; responsavel?: string; obs?: string; prioridade?: 1 | 2 | 3 }): Promise<Missao> {
  if (campos.status !== undefined && (!STATUS_MISSAO.some((s) => s.id === campos.status) || !STATUS_MANUAIS.includes(campos.status))) throw new Error("Status inválido");
  if (campos.prioridade !== undefined && ![1, 2, 3].includes(campos.prioridade)) throw new Error("Prioridade inválida");
  let editada: Missao | null = null;
  await atualizarJson(ARQUIVO_MISSOES, vazio, (e) => {
    const m = e.missoes[id];
    if (!m) return false;
    const agora = new Date().toISOString();
    if (campos.status !== undefined && campos.status !== m.status) {
      m.status = campos.status;
      m.concluidaEm = campos.status === "feita" ? agora : null;
      if (campos.status === "cancelada" && !m.motivoCancelamento) m.motivoCancelamento = "Cancelada manualmente";
      if (campos.status !== "cancelada") m.motivoCancelamento = "";
      if (campos.status === "feita") m.baseEm = m.baseEm || agora; // a próxima planilha confirma
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

  const linhaOrigem = e.tipo === "recompletamento" ? (ctx.linhasSc.get(e.pi) ?? []).filter((l) => l.dep === e.de.dep && l.end === e.de.end) : [];
  const unica = linhaOrigem.length === 1 ? linhaOrigem[0] : null;
  let criada: Missao | null = null;
  await atualizarJson(ARQUIVO_MISSOES, vazio, (est) => {
    const letra = e.tipo === "recompletamento" ? "R" : "A";
    const id = `${letra}-${String(++est.seq[letra]).padStart(6, "0")}`;
    const agora = new Date().toISOString();
    const cxp = ctx.limites(e.pi)?.cxp;
    criada = {
      id, tipo: e.tipo, origem: "manual", status: "pendente", prioridade: e.prioridade ?? 2, onda: 1, pi: e.pi, desc: ctx.produtoDesc(e.pi), qtd,
      caixas: e.tipo === "recompletamento" && cxp ? Math.round((qtd / cxp) * 100) / 100 : null, de: e.de, para: e.para,
      lote: unica?.lote ?? "", validade: unica?.val ?? "", idQuant: unica?.id ?? "", motivo: "Missão manual", chave: "",
      responsavel: e.responsavel ?? "", obs: e.obs ?? "", criadaEm: agora, atualizadoEm: agora, concluidaEm: null, verificadaEm: null, motivoCancelamento: "",
      baseOrigem: ctx.livreLoc.get(`${e.pi}|${chaveLoc(e.de)}`) ?? 0, baseDestino: ctx.livreLoc.get(`${e.pi}|${chaveLoc(e.para)}`) ?? 0, baseEm: ctx.estoqueEm, nota: "",
    };
    est.missoes[id] = criada;
    return true;
  });
  return criada!;
}

export async function salvarParametros(p: Partial<Parametros>): Promise<Parametros> {
  const n = (v: unknown, min: number, max: number, def: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
  const locs = (l: unknown): Local[] => {
    const vistos = new Set<string>();
    return ((Array.isArray(l) ? l : []) as Local[]).map((x) => ({ dep: String(x?.dep ?? "").trim().toUpperCase(), end: String(x?.end ?? "").trim().toUpperCase() }))
      .filter((x) => x.dep && x.end && !vistos.has(x.dep + "|" + x.end) && vistos.add(x.dep + "|" + x.end)).slice(0, 5000);
  };
  const final = await atualizarJson(ARQUIVO_MISSOES, vazio, (e) => {
    const a = mesclar(e.params);
    if (p.maxCaixas !== undefined) a.maxCaixas = n(p.maxCaixas, 1, 100, a.maxCaixas);
    if (p.minCaixas !== undefined) a.minCaixas = n(p.minCaixas, 1, 100, a.minCaixas);
    if (p.maxCaixasCalcado !== undefined) a.maxCaixasCalcado = n(p.maxCaixasCalcado, 1, 100, a.maxCaixasCalcado);
    if (p.minCaixasCalcado !== undefined) a.minCaixasCalcado = n(p.minCaixasCalcado, 1, 100, a.minCaixasCalcado);
    if (p.pedidosCobertura !== undefined) a.pedidosCobertura = n(p.pedidosCobertura, 1, 50, a.pedidosCobertura);
    if (p.caixasZona !== undefined) a.caixasZona = n(p.caixasZona, 1, 50, a.caixasZona);
    if (p.pisPorLocZona !== undefined) a.pisPorLocZona = n(p.pisPorLocZona, 1, 100, a.pisPorLocZona);
    if (p.caixasPorPi !== undefined) a.caixasPorPi = Object.fromEntries(Object.entries(p.caixasPorPi).filter(([k, v]) => k && Number(v) > 0).map(([k, v]) => [String(k).trim(), Number(v)]).slice(0, 5000));
    if (p.locsVazias !== undefined) a.locsVazias = locs(p.locsVazias);
    if (p.locsVaziasSc !== undefined) a.locsVaziasSc = locs(p.locsVaziasSc);
    e.params = a;
    return true;
  });
  return mesclar(final.params);
}

export { ABERTA, EM_ANDAMENTO };
