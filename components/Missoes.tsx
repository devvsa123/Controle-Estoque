"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ABERTA, STATUS_MISSAO, type Alerta, type AvisoValidacao, type Missao, type Parametros, type StatusMissao, type TipoMissao,
} from "@/lib/missoes";
import type { Dados } from "@/lib/types";
import { NOME_DEPOSITO } from "@/lib/config";
import { csv, fmtDataHora, fmtNum, norm } from "@/lib/util";

/* ------------------------------------------------------------------ estado compartilhado */

interface Resposta {
  missoes: Missao[];
  params: Parametros;
  alertas: Alerta[];
  rmErro: string | null;
  estoqueEm: string | null;
  geradoEm: string;
}

interface Ctx {
  dados: Resposta | null;
  erro: string | null;
  carregando: boolean;
  iniciar: () => void;
  recarregar: () => Promise<void>;
  trocar: (m: Missao) => void;
  post: (corpo: unknown) => Promise<{ ok: boolean; status: number; json: any }>;
}

const C = createContext<Ctx | null>(null);
const usar = () => {
  const c = useContext(C);
  if (!c) throw new Error("fora do provedor de missões");
  return c;
};

/** Carrega as missões uma vez (na primeira vez que alguma aba de missões é aberta) e compartilha entre as abas. */
export function MissoesProvider({ children }: { children: React.ReactNode }) {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const iniciado = useRef(false);

  const recarregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetch("/api/missoes", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha ao carregar as missões");
      setDados(j);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar as missões");
    } finally {
      setCarregando(false);
    }
  }, []);

  const iniciar = useCallback(() => {
    if (iniciado.current) return;
    iniciado.current = true;
    recarregar();
  }, [recarregar]);

  const trocar = useCallback((m: Missao) => setDados((d) => (d ? { ...d, missoes: d.missoes.map((x) => (x.id === m.id ? m : x)) } : d)), []);

  const post = useCallback(async (corpo: unknown) => {
    const r = await fetch("/api/missoes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    return { ok: r.ok, status: r.status, json: await r.json() };
  }, []);

  return <C.Provider value={{ dados, erro, carregando, iniciar, recarregar, trocar, post }}>{children}</C.Provider>;
}

/** Contagem de alertas para o selo do menu. */
export function useContagemAlertas(): { critico: number; atencao: number } {
  const c = useContext(C);
  const a = c?.dados?.alertas ?? [];
  return { critico: a.filter((x) => x.nivel === "critico").length, atencao: a.filter((x) => x.nivel === "atencao").length };
}

function Carga({ children }: { children: (d: Resposta) => React.ReactNode }) {
  const { dados, erro, carregando, iniciar, recarregar } = usar();
  useEffect(() => iniciar(), [iniciar]);
  if (erro)
    return (
      <div className="card err">
        <strong>Não foi possível carregar as missões.</strong>
        <p>{erro}</p>
        <button className="btn" onClick={recarregar}>Tentar novamente</button>
      </div>
    );
  if (!dados) return <p className="muted">{carregando ? "Gerando as missões a partir do estoque e dos pedidos (a primeira vez leva alguns segundos)…" : ""}</p>;
  return <>{children(dados)}</>;
}

/* ------------------------------------------------------------------------- textos */

const REGRAS: Record<TipoMissao, string[]> = {
  recompletamento: [
    "Vale para PIs que já tiveram pedido fracionado e não têm saldo no P04.",
    "Dispara quando o saldo livre no FR fica abaixo do mínimo de caixas padrão (parâmetro).",
    "Repõe até a cobertura de dias escolhida (média de saída das sobras), no mínimo o mínimo de caixas e no máximo o que cabe na LOC.",
    "Só caixas fechadas, de linhas SC livres: mesmo paiol primeiro, depois a validade mais próxima (FEFO).",
    "Destino: a LOC FR do PI com maior saldo, de preferência onde ele está sozinho.",
  ],
  movimentacao: [
    "Objetivo: 1 PI por LOC FR. Ficam de fora o P04 e a rua 12 do P02.",
    "Juntar: PI espalhado em várias LOCs vai para a LOC onde está sozinho e que ainda comporta o saldo.",
    "Desmisturar: em LOC com mais de um PI fica o PI com giro fracionado (ou o de maior saldo); os outros vão para uma LOC onde já estão sozinhos ou para uma LOC vazia informada nos parâmetros.",
    "Sem destino possível, vira alerta: o sistema não inventa LOC. Saldo bloqueado não é movimentado.",
  ],
};

const NOME_TIPO: Record<TipoMissao, string> = { recompletamento: "Recompletamento (SC → FR)", movimentacao: "Movimentação para ajuste do FR" };
const PRIO = { 1: { nome: "Alta", tom: "bad" }, 2: { nome: "Normal", tom: "warn" }, 3: { nome: "Baixa", tom: "neutral" } } as const;
const loc = (l: { dep: string; end: string }) => `${l.dep} · ${l.end}`;

/* --------------------------------------------------------------- aba por tipo de missão */

export function MissoesTipo({ tipo, estoque }: { tipo: TipoMissao; estoque: Dados | null }) {
  const [sub, setSub] = useState<"lista" | "manual">("lista");
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="bar" style={{ marginBottom: 0 }}>
        <h2 style={{ margin: 0, fontSize: 16, textTransform: "none", letterSpacing: 0, color: "var(--ink)" }}>{NOME_TIPO[tipo]}</h2>
        <div className="seg" role="group" aria-label="Visão">
          <button aria-pressed={sub === "lista"} onClick={() => setSub("lista")}>Missões</button>
          <button aria-pressed={sub === "manual"} onClick={() => setSub("manual")}>Nova missão manual</button>
        </div>
      </div>
      <Carga>
        {(d) => (
          <>
            <Parametrologia tipo={tipo} params={d.params} />
            {d.rmErro && <div className="note">Missões automáticas desativadas: {d.rmErro}. As manuais continuam funcionando.</div>}
            {sub === "lista" ? <Lista tipo={tipo} missoes={d.missoes.filter((m) => m.tipo === tipo)} geradoEm={d.geradoEm} estoqueEm={d.estoqueEm} /> : <Manual tipo={tipo} estoque={estoque} onCriada={() => setSub("lista")} />}
          </>
        )}
      </Carga>
    </div>
  );
}

/* --------------------------------------------------------------------- parâmetros */

function Parametrologia({ tipo, params }: { tipo: TipoMissao; params: Parametros }) {
  const { post, recarregar } = usar();
  const [p, setP] = useState(params);
  const [vazias, setVazias] = useState(params.locsVazias.map((l) => `${l.dep} ${l.end}`).join("\n"));
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setP(params); setVazias(params.locsVazias.map((l) => `${l.dep} ${l.end}`).join("\n")); }, [params]);

  async function salvar(extra?: Partial<Parametros>) {
    setSalvando(true);
    setMsg(null);
    const locsVazias = vazias.split("\n").map((s) => s.trim().split(/\s+/)).filter((a) => a.length >= 2).map(([dep, end]) => ({ dep, end }));
    const r = await post({ acao: "params", params: { ...p, locsVazias, ...extra } });
    setSalvando(false);
    if (!r.ok) { setMsg(r.json.erro || "Falha ao salvar"); return; }
    setMsg("Salvo. Regerando as missões…");
    await recarregar();
    setMsg("Salvo.");
  }

  function importarLocal() {
    try {
      const j = JSON.parse(localStorage.getItem("controle-estoque:rm:v2") || "{}");
      const c = j?.caixasPorPi ?? {};
      if (!Object.keys(c).length) { setMsg("Nenhum ajuste por PI neste navegador."); return; }
      salvar({ caixasPorPi: { ...p.caixasPorPi, ...c } });
    } catch { setMsg("Não consegui ler os ajustes deste navegador."); }
  }

  const num = (k: keyof Parametros, rot: string, w = 90) => (
    <label>
      {rot}
      <input type="number" min={0} value={p[k] as number} style={{ width: w }} onChange={(e) => setP({ ...p, [k]: +e.target.value })} />
    </label>
  );

  return (
    <details className="card">
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Regras e parâmetros (compartilhados por todos)</summary>
      <ul style={{ margin: "8px 0 8px 18px", padding: 0 }}>{REGRAS[tipo].map((t) => <li key={t}>{t}</li>)}</ul>
      <div className="filters" style={{ padding: 0, marginBottom: 0 }}>
        {tipo === "recompletamento" ? (
          <>
            {num("minCaixasFr", "Mínimo de caixas no FR")}
            {num("diasAlvo", "Cobertura alvo (dias)")}
            {num("janela", "Janela da média (dias)")}
            {num("limiteRecomp", "Máx. missões automáticas abertas")}
          </>
        ) : (
          <>
            {num("limiteMov", "Máx. missões automáticas abertas")}
          </>
        )}
        {num("caixasLoc", "Caixas por LOC FR")}
        {tipo === "movimentacao" && (
          <label style={{ flex: "1 1 260px" }}>
            LOCs FR vazias disponíveis (uma por linha: PAIOL ENDEREÇO)
            <textarea value={vazias} rows={4} onChange={(e) => setVazias(e.target.value)} placeholder={"P02 05-10-01-AA\nP02 05-10-01-BB"}
              style={{ padding: 7, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)", font: "inherit" }} />
          </label>
        )}
      </div>
      <div className="bar" style={{ marginTop: 8, marginBottom: 0 }}>
        <button className="btn" onClick={() => salvar()} disabled={salvando}>{salvando ? "Salvando…" : "Salvar parâmetros"}</button>
        <button className="btn" onClick={importarLocal} disabled={salvando} title="Copia para o servidor os valores de caixas por LOC por PI ajustados na aba Análise de RM deste navegador">Importar caixas/LOC por PI deste navegador</button>
        <span className="muted small">{Object.keys(p.caixasPorPi).length} PI(s) com caixas/LOC próprias. {msg}</span>
      </div>
      {tipo === "movimentacao" && <p className="muted small">A planilha só mostra LOCs com saldo. Para o sistema mandar PIs para LOCs vazias, informe aqui quais estão livres.</p>}
    </details>
  );
}

/* ----------------------------------------------------------------------- listagem */

type Filtro = "abertas" | "concluidas" | "canceladas" | "todas";

function Lista({ tipo, missoes, geradoEm, estoqueEm }: { tipo: TipoMissao; missoes: Missao[]; geradoEm: string; estoqueEm: string | null }) {
  const { post, trocar, recarregar, carregando } = usar();
  const [filtro, setFiltro] = useState<Filtro>("abertas");
  const [q, setQ] = useState("");
  const [origem, setOrigem] = useState<"" | "auto" | "manual">("");
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);

  const cont = useMemo(() => ({
    abertas: missoes.filter((m) => ABERTA(m.status)).length,
    pendentes: missoes.filter((m) => m.status === "pendente").length,
    exec: missoes.filter((m) => m.status === "em_execucao").length,
    alta: missoes.filter((m) => ABERTA(m.status) && m.prioridade === 1).length,
    concluidas: missoes.filter((m) => m.status === "concluida").length,
    canceladas: missoes.filter((m) => m.status === "cancelada").length,
  }), [missoes]);

  const lista = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return missoes
      .filter((m) => (filtro === "abertas" ? ABERTA(m.status) : filtro === "concluidas" ? m.status === "concluida" : filtro === "canceladas" ? m.status === "cancelada" : true))
      .filter((m) => !origem || m.origem === origem)
      .filter((m) => !toks.length || toks.every((t) => norm(`${m.id} ${m.pi} ${m.desc} ${m.de.end} ${m.para.end} ${m.responsavel} ${m.obs}`).includes(t)));
  }, [missoes, filtro, q, origem]);

  async function alterar(m: Missao, campos: Record<string, unknown>) {
    setErro(null);
    const r = await post({ acao: "alterar", id: m.id, campos });
    if (!r.ok) { setErro(r.json.erro || "Falha ao salvar"); return; }
    trocar(r.json.missao);
  }

  function exportar() {
    const cab = ["Missão", "Prioridade", "Status", "PI", "Descrição", "Quantidade (un)", "Caixas", "De (paiol)", "De (endereço)", "Para (paiol)", "Para (endereço)", "Lote", "Validade", "Origem da missão", "Responsável", "Observação", "Motivo", "Criada em"];
    const corpo = lista.map((m) => [m.id, PRIO[m.prioridade].nome, STATUS_MISSAO.find((s) => s.id === m.status)!.nome, m.pi, m.desc, String(m.qtd).replace(".", ","), m.caixas ?? "", m.de.dep, m.de.end, m.para.dep, m.para.end, m.lote, m.validade, m.origem === "auto" ? "Automática" : "Manual", m.responsavel, m.obs, m.motivo, fmtDataHora(m.criadaEm)]);
    const blob = new Blob(["﻿" + csv([cab, ...corpo])], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `missoes-${tipo}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <div className="grid g4">
        <div className="card kpi bad"><div className="v">{fmtNum(cont.alta)}</div><div className="l">Abertas de prioridade alta</div></div>
        <div className="card kpi warn"><div className="v">{fmtNum(cont.pendentes)}</div><div className="l">Pendentes</div></div>
        <div className="card kpi"><div className="v">{fmtNum(cont.exec)}</div><div className="l">Em execução</div></div>
        <div className="card kpi ok"><div className="v">{fmtNum(cont.concluidas)}</div><div className="l">Concluídas · {fmtNum(cont.canceladas)} canceladas</div></div>
      </div>
      <div className="card">
        {erro && <div className="note" style={{ background: "var(--bad-soft)", color: "var(--bad)" }}>{erro}</div>}
        <div className="bar" style={{ justifyContent: "space-between" }}>
          <div className="seg" role="group" aria-label="Filtro">
            <button aria-pressed={filtro === "abertas"} onClick={() => setFiltro("abertas")}>Abertas ({fmtNum(cont.abertas)})</button>
            <button aria-pressed={filtro === "concluidas"} onClick={() => setFiltro("concluidas")}>Concluídas</button>
            <button aria-pressed={filtro === "canceladas"} onClick={() => setFiltro("canceladas")}>Canceladas</button>
            <button aria-pressed={filtro === "todas"} onClick={() => setFiltro("todas")}>Todas</button>
          </div>
          <input type="search" placeholder="Buscar missão, PI, endereço, responsável…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220, flex: "1 1 220px" }} />
          <select value={origem} onChange={(e) => setOrigem(e.target.value as typeof origem)} aria-label="Origem da missão">
            <option value="">Automáticas e manuais</option>
            <option value="auto">Só automáticas</option>
            <option value="manual">Só manuais</option>
          </select>
          <button className="btn" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
          <button className="btn" onClick={recarregar} disabled={carregando}>{carregando ? "Atualizando…" : "Atualizar"}</button>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Prio.</th><th>Missão</th><th>PI</th><th className="n">{tipo === "recompletamento" ? "Caixas" : "Quantidade"}</th><th>De</th><th>Para</th>
                <th>Status</th><th>Responsável</th><th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((m) => (
                <MissaoLinha key={m.id} m={m} tipo={tipo} aberto={aberto === m.id} onToggle={() => setAberto(aberto === m.id ? null : m.id)} onAlterar={alterar} />
              ))}
            </tbody>
          </table>
        </div>
        {lista.length === 0 && <p className="muted">Nenhuma missão neste filtro.</p>}
        <p className="muted small">
          As missões automáticas são geradas/atualizadas a cada vez que esta tela carrega (estoque de {fmtDataHora(estoqueEm)}, gerado em {fmtDataHora(geradoEm)}). Uma missão concluída conta como
          feita mesmo antes de a planilha de estoque refletir, para o sistema não repetir a missão. Missões automáticas pendentes que perdem o sentido são canceladas sozinhas.
        </p>
      </div>
    </>
  );
}

function MissaoLinha({ m, tipo, aberto, onToggle, onAlterar }: { m: Missao; tipo: TipoMissao; aberto: boolean; onToggle: () => void; onAlterar: (m: Missao, c: Record<string, unknown>) => void }) {
  const encerrada = !ABERTA(m.status);
  return (
    <>
      <tr className="click" onClick={onToggle} style={encerrada ? { opacity: 0.65 } : undefined}>
        <td><span className={`tag ${PRIO[m.prioridade].tom}`}>{PRIO[m.prioridade].nome}</span></td>
        <td>{aberto ? "▾" : "▸"} {m.id}{m.origem === "manual" && <span className="tag neutral" style={{ marginLeft: 4 }}>manual</span>}</td>
        <td className="wrapc"><strong>{m.pi}</strong> {m.desc}</td>
        <td className="n">{tipo === "recompletamento" && m.caixas ? <>{fmtNum(m.caixas)} cx <span className="muted small">({fmtNum(m.qtd)} un)</span></> : `${fmtNum(m.qtd)} un`}</td>
        <td title={NOME_DEPOSITO[m.de.dep]}>{loc(m.de)}</td>
        <td title={NOME_DEPOSITO[m.para.dep]}>{loc(m.para)}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select value={m.status} onChange={(e) => onAlterar(m, { status: e.target.value as StatusMissao })} aria-label={`Status da missão ${m.id}`}>
            {STATUS_MISSAO.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
          </select>
        </td>
        <td onClick={(e) => e.stopPropagation()}><Campo valor={m.responsavel} largura={120} rotulo={`Responsável pela missão ${m.id}`} onSalvar={(v) => onAlterar(m, { responsavel: v })} /></td>
        <td onClick={(e) => e.stopPropagation()}><Campo valor={m.obs} largura={200} rotulo={`Observação da missão ${m.id}`} onSalvar={(v) => onAlterar(m, { obs: v })} /></td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={9}>
            <p style={{ margin: "4px 0" }}><strong>Por quê:</strong> {m.motivo}</p>
            <p className="muted small" style={{ margin: "4px 0" }}>
              {m.lote && <>Lote {m.lote}{m.validade ? ` · validade ${m.validade.split("-").reverse().join("/")}` : ""} · </>}
              {m.idQuant && <>ID_QUANT {m.idQuant} · </>}
              criada {fmtDataHora(m.criadaEm)}{m.concluidaEm ? ` · concluída ${fmtDataHora(m.concluidaEm)}` : ""}
              {m.motivoCancelamento ? ` · ${m.motivoCancelamento}` : ""}
            </p>
            <div className="bar" style={{ marginBottom: 0 }}>
              <span className="muted small">Prioridade:</span>
              {([1, 2, 3] as const).map((p) => <button key={p} className="chip" aria-pressed={m.prioridade === p} onClick={() => onAlterar(m, { prioridade: p })}>{PRIO[p].nome}</button>)}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Campo({ valor, largura, rotulo, onSalvar }: { valor: string; largura: number; rotulo: string; onSalvar: (v: string) => void }) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  return (
    <input type="text" value={v} maxLength={600} aria-label={rotulo} onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== valor.trim() && onSalvar(v.trim())} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      style={{ width: largura, padding: "4px 7px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)" }} />
  );
}

/* ------------------------------------------------------------------ missão manual */

function Manual({ tipo, estoque, onCriada }: { tipo: TipoMissao; estoque: Dados | null; onCriada: () => void }) {
  const { post, recarregar } = usar();
  const [pi, setPi] = useState("");
  const [de, setDe] = useState({ dep: "", end: "" });
  const [para, setPara] = useState({ dep: "", end: "" });
  const [caixas, setCaixas] = useState("");
  const [qtd, setQtd] = useState("");
  const [prio, setPrio] = useState<1 | 2 | 3>(2);
  const [resp, setResp] = useState("");
  const [obs, setObs] = useState("");
  const [avisos, setAvisos] = useState<AvisoValidacao[] | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const piLimpo = pi.trim();
  const desc = estoque?.produtos[piLimpo]?.desc;
  const sugestoes = useMemo(() => {
    if (!estoque || piLimpo.length < 3 || desc) return [];
    const toks = norm(piLimpo).split(/\s+/);
    return Object.entries(estoque.produtos).filter(([k, p]) => toks.every((t) => norm(`${k} ${p.desc}`).includes(t))).slice(0, 8);
  }, [estoque, piLimpo, desc]);

  // LOCs conhecidas do PI, para preencher origem/destino com um clique
  const locsPi = useMemo(() => {
    const r = { sc: [] as { dep: string; end: string; qtd: number }[], fr: [] as { dep: string; end: string; qtd: number }[] };
    if (!estoque || !desc) return r;
    const acc = (area: string) => {
      const m = new Map<string, { dep: string; end: string; qtd: number }>();
      for (const l of estoque.linhas) {
        if (l.pi !== piLimpo || l.area !== area || estoque.escopos[l.dep] !== "estoque" || !l.livre || l.disp <= 0) continue;
        const k = l.dep + "|" + l.end;
        const e = m.get(k) ?? { dep: l.dep, end: l.end, qtd: 0 };
        e.qtd += l.disp; m.set(k, e);
      }
      return [...m.values()].sort((a, b) => b.qtd - a.qtd);
    };
    return { sc: acc("SC"), fr: acc("FR") };
  }, [estoque, piLimpo, desc]);

  const origemOpcoes = tipo === "recompletamento" ? locsPi.sc : locsPi.fr;
  const destinoOpcoes = locsPi.fr;

  async function enviar(forcar: boolean) {
    setEnviando(true);
    setMsg(null);
    const r = await post({
      acao: "manual", forcar,
      missao: { tipo, pi: piLimpo, caixas: tipo === "recompletamento" && caixas ? +caixas : undefined, qtd: qtd ? +qtd : undefined, de, para, prioridade: prio, responsavel: resp, obs },
    });
    setEnviando(false);
    if (r.ok) {
      setMsg(`Missão ${r.json.missao.id} criada.`);
      setAvisos(null); setConfirmar(false);
      setPi(""); setCaixas(""); setQtd(""); setDe({ dep: "", end: "" }); setPara({ dep: "", end: "" }); setObs("");
      await recarregar();
      onCriada();
      return;
    }
    setAvisos(r.json.avisos ?? [{ nivel: "erro", texto: r.json.erro || "Falha ao criar a missão" }]);
    setConfirmar(r.status === 409);
  }

  const campoLoc = (rot: string, v: { dep: string; end: string }, set: (v: { dep: string; end: string }) => void, opc: { dep: string; end: string; qtd: number }[]) => (
    <div className="card" style={{ flex: "1 1 280px" }}>
      <h2>{rot}</h2>
      <div className="filters" style={{ padding: 0, marginBottom: 6 }}>
        <label>Paiol<input type="text" value={v.dep} onChange={(e) => set({ ...v, dep: e.target.value.toUpperCase() })} placeholder="P02" style={{ width: 80, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)" }} /></label>
        <label style={{ flex: 1 }}>Endereço<input type="text" value={v.end} onChange={(e) => set({ ...v, end: e.target.value.toUpperCase() })} placeholder="02-10-01-AA" style={{ padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)" }} /></label>
      </div>
      {opc.length > 0 && (
        <div className="chips">
          {opc.slice(0, 8).map((o) => <button key={o.dep + o.end} className="chip" onClick={() => set({ dep: o.dep, end: o.end })}>{o.dep} {o.end} · {fmtNum(o.qtd)} un</button>)}
        </div>
      )}
    </div>
  );

  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        {tipo === "recompletamento" ? "Leve caixas fechadas de uma LOC SC para a LOC FR do PI." : "Mova saldo de uma LOC FR para outra LOC FR para ajustar o layout."} O sistema confere a missão contra o estoque e avisa se alguma regra for quebrada; você decide se cria mesmo assim.
      </p>
      <div className="filters" style={{ padding: 0 }}>
        <label style={{ flex: "1 1 260px" }}>
          PI (código ou nome)
          <input type="search" value={pi} onChange={(e) => { setPi(e.target.value); setAvisos(null); }} placeholder="Ex.: 190012433 ou calça branca 44" />
        </label>
        {tipo === "recompletamento" && <label>Caixas<input type="number" min={0} value={caixas} onChange={(e) => { setCaixas(e.target.value); setQtd(""); }} style={{ width: 90 }} /></label>}
        <label>{tipo === "recompletamento" ? "ou unidades" : "Unidades"}<input type="number" min={0} value={qtd} onChange={(e) => { setQtd(e.target.value); setCaixas(""); }} style={{ width: 110 }} /></label>
        <label>Prioridade
          <select value={prio} onChange={(e) => setPrio(+e.target.value as 1 | 2 | 3)}>
            <option value={1}>Alta</option><option value={2}>Normal</option><option value={3}>Baixa</option>
          </select>
        </label>
      </div>
      {desc && <p style={{ margin: "6px 0" }}><strong>{piLimpo}</strong> · {desc}</p>}
      {sugestoes.length > 0 && (
        <div className="chips" style={{ margin: "6px 0" }}>
          {sugestoes.map(([k, p]) => <button key={k} className="chip" onClick={() => setPi(k)}>{k} · {p.desc}</button>)}
        </div>
      )}
      <div className="bar" style={{ alignItems: "stretch", marginTop: 8 }}>
        {campoLoc("Origem", de, setDe, origemOpcoes)}
        {campoLoc("Destino", para, setPara, destinoOpcoes)}
      </div>
      <div className="filters" style={{ padding: 0 }}>
        <label>Responsável<input type="text" value={resp} onChange={(e) => setResp(e.target.value)} style={{ width: 160, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)" }} /></label>
        <label style={{ flex: 1 }}>Observação<input type="text" value={obs} onChange={(e) => setObs(e.target.value)} maxLength={600} style={{ padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)" }} /></label>
      </div>
      {avisos && (
        <div className="note" style={avisos.some((a) => a.nivel === "erro") ? { background: "var(--bad-soft)", color: "var(--bad)" } : undefined}>
          <strong>{avisos.some((a) => a.nivel === "erro") ? "Corrija antes de criar:" : "Atenção — a lógica será quebrada:"}</strong>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>{avisos.map((a, i) => <li key={i}>{a.texto}</li>)}</ul>
        </div>
      )}
      <div className="bar" style={{ marginBottom: 0 }}>
        <button className="btn" onClick={() => enviar(false)} disabled={enviando || !piLimpo}>{enviando ? "Criando…" : "Criar missão"}</button>
        {confirmar && <button className="btn" onClick={() => enviar(true)} disabled={enviando} style={{ borderColor: "var(--warn)", color: "var(--warn)" }}>Criar mesmo assim</button>}
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ alertas */

const NOME_NIVEL = { critico: "Crítico", atencao: "Atenção", info: "Informativo" } as const;
const TOM_NIVEL = { critico: "bad", atencao: "warn", info: "neutral" } as const;

export function AlertasView() {
  return (
    <Carga>
      {(d) => <AlertasLista alertas={d.alertas} />}
    </Carga>
  );
}

function AlertasLista({ alertas }: { alertas: Alerta[] }) {
  const { recarregar, carregando } = usar();
  const [tipo, setTipo] = useState<"" | TipoMissao>("");
  const lista = alertas.filter((a) => !tipo || !a.tipo || a.tipo === tipo);
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="bar" style={{ marginBottom: 0, justifyContent: "space-between" }}>
        <p className="muted small" style={{ margin: 0 }}>Cada alerta indica uma regra que está sendo quebrada ou prestes a ser. Eles são recalculados toda vez que as missões são atualizadas.</p>
        <span style={{ display: "flex", gap: 8 }}>
          <select value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)} aria-label="Tipo">
            <option value="">Todos</option><option value="recompletamento">Recompletamento</option><option value="movimentacao">Movimentação FR</option>
          </select>
          <button className="btn" onClick={recarregar} disabled={carregando}>{carregando ? "Atualizando…" : "Atualizar"}</button>
        </span>
      </div>
      {lista.length === 0 && <div className="card kpi ok"><div className="v">Nenhum alerta</div><div className="l">Nenhuma regra quebrada no momento.</div></div>}
      {lista.map((a) => (
        <div key={a.id} className="card" style={{ borderLeft: `4px solid var(--${a.nivel === "critico" ? "bad" : a.nivel === "atencao" ? "warn" : "brand"})` }}>
          <div className="bar" style={{ marginBottom: 4, justifyContent: "space-between" }}>
            <strong>{a.titulo}</strong>
            <span><span className={`tag ${TOM_NIVEL[a.nivel]}`}>{NOME_NIVEL[a.nivel]}</span>{a.total !== undefined && <span className="tag neutral" style={{ marginLeft: 4 }}>{fmtNum(a.total)}</span>}</span>
          </div>
          <p style={{ margin: "2px 0" }}>{a.detalhe}</p>
          <p className="muted small" style={{ margin: "2px 0" }}>Regra: {a.regra}{a.tipo ? ` · ${NOME_TIPO[a.tipo]}` : ""}</p>
          {a.exemplos && a.exemplos.length > 0 && (
            <ul className="small" style={{ margin: "6px 0 0 18px", padding: 0 }}>
              {a.exemplos.map((x, i) => <li key={i}>{x}</li>)}
              {a.total && a.total > a.exemplos.length && <li className="muted">… e mais {fmtNum(a.total - a.exemplos.length)}</li>}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
