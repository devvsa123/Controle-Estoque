"use client";

import { useEffect, useMemo, useState } from "react";
import type { RmDados } from "@/lib/rm";
import type { Dados } from "@/lib/types";
import {
  NOME_GRUPO, PARAMS_PADRAO, calcReposicao, estoquePorPi, visaoGeral,
  type ItemRepo, type ParamsRepo,
} from "@/lib/rmAnalise";
import { csv, fmtDataHora, fmtNum, norm } from "@/lib/util";

type Sub = "geral" | "reposicao";

const CHAVE_LS = "controle-estoque:rm:v1";

function lerLS<T>(def: T): T {
  try {
    const s = localStorage.getItem(CHAVE_LS);
    return s ? { ...def, ...JSON.parse(s) } : def;
  } catch {
    return def;
  }
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—");
const diaParaData = (d: number) => new Date(d * 86400000).toLocaleDateString("pt-BR", { timeZone: "UTC" });

export default function AnaliseRM({ estoque }: { estoque: Dados | null }) {
  const [rm, setRm] = useState<RmDados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [sub, setSub] = useState<Sub>("geral");

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetch("/api/rm", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha ao carregar a planilha de pedidos");
      setRm(j);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar");
    } finally {
      setCarregando(false);
    }
  }
  useEffect(() => {
    carregar();
  }, []);

  if (erro)
    return (
      <div className="card err">
        <strong>Não foi possível carregar a planilha de pedidos.</strong>
        <p>{erro}</p>
        <button className="btn" onClick={carregar}>Tentar novamente</button>
      </div>
    );
  if (!rm)
    return <p className="muted">{carregando ? "Carregando a planilha de pedidos (a primeira leitura pode levar alguns segundos)…" : ""}</p>;

  if (rm.faltando.length)
    return (
      <div className="card err">
        <strong>A planilha de pedidos não tem as colunas necessárias: {rm.faltando.join(", ")}.</strong>
        <p>
          Arquivo lido: <code>{rm.arquivo}</code>. Colunas encontradas: {rm.colunas.join(", ") || "nenhuma"}.
        </p>
        <p>
          A análise precisa de <code>QTD</code> (quantidade do pedido) e <code>CXP</code> (quantidade padrão por caixa). Se elas existem com outro
          nome, me diga qual para eu ajustar.
        </p>
      </div>
    );

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="bar" style={{ marginBottom: 0, justifyContent: "space-between" }}>
        <div className="seg" role="group" aria-label="Análise">
          <button aria-pressed={sub === "geral"} onClick={() => setSub("geral")}>Visão geral e grupos</button>
          <button aria-pressed={sub === "reposicao"} onClick={() => setSub("reposicao")}>Reposição do FR</button>
        </div>
        <span className="muted small">
          {fmtNum(rm.resumo.validas)} linhas de pedido · arquivo de {fmtDataHora(rm.atualizadoEm)}{rm.fonte === "local" ? " (local)" : ""} ·{" "}
          <button className="btn" onClick={carregar} disabled={carregando}>{carregando ? "Atualizando…" : "Recarregar"}</button>
        </span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Cada linha da planilha é um item de uma RM. Pedido <strong>fracionado</strong> = QTD que não é múltiplo da caixa padrão (CXP). Cancelados ficam de fora
        {rm.resumo.canceladas ? ` (${fmtNum(rm.resumo.canceladas)})` : ""}
        {rm.resumo.semQtd + rm.resumo.semCxp + rm.resumo.semData > 0
          ? `; ${fmtNum(rm.resumo.semQtd + rm.resumo.semCxp + rm.resumo.semData)} linhas sem QTD/CXP/data válidos também foram ignoradas`
          : ""}.
      </p>
      {sub === "geral" ? <Geral rm={rm} /> : <Reposicao rm={rm} estoque={estoque} />}
    </div>
  );
}

/* ---------------------------------------------------------------- Visão geral */

const PERIODOS = [
  { v: 0, nome: "Todo o histórico" },
  { v: 365, nome: "Últimos 12 meses" },
  { v: 180, nome: "Últimos 6 meses" },
  { v: 90, nome: "Últimos 90 dias" },
  { v: 30, nome: "Últimos 30 dias" },
];

function Geral({ rm }: { rm: RmDados }) {
  const [periodo, setPeriodo] = useState(0);
  const [grupoSel, setGrupoSel] = useState<0 | 1 | 2 | 3>(0);

  const { ultimo } = useMemo(() => {
    let u = -Infinity;
    for (const d of rm.d) if (d > u) u = d;
    return { ultimo: u };
  }, [rm]);

  const v = useMemo(
    () => visaoGeral(rm, { dMin: periodo ? ultimo - periodo + 1 : -Infinity, dMax: Infinity }),
    [rm, periodo, ultimo]
  );

  const meses = v.porMes.slice(-24);
  const maxPct = Math.max(0.0001, ...meses.map((m) => (m.linhas ? m.fracionadas / m.linhas : 0)));
  const grupos = [1, 2, 3] as const;

  return (
    <>
      <div className="bar" style={{ marginBottom: 0 }}>
        <label className="muted small">
          Período{" "}
          <select value={periodo} onChange={(e) => setPeriodo(+e.target.value)}>
            {PERIODOS.map((p) => <option key={p.v} value={p.v}>{p.nome}</option>)}
          </select>
        </label>
        {v.linhas > 0 && <span className="muted small">de {diaParaData(v.primeiroDia)} a {diaParaData(v.ultimoDia)}</span>}
      </div>

      <div className="grid g4">
        <div className="card kpi"><div className="v">{fmtNum(v.linhas)}</div><div className="l">Pedidos (itens de RM) no período</div></div>
        <div className="card kpi warn"><div className="v">{pct(v.fracionadas, v.linhas)}</div><div className="l">{fmtNum(v.fracionadas)} de {fmtNum(v.linhas)} geraram fracionado</div></div>
        <div className="card kpi ok"><div className="v">{pct(v.fechadas, v.linhas)}</div><div className="l">{fmtNum(v.fechadas)} foram só caixa fechada</div></div>
        <div className="card kpi"><div className="v">{pct(v.rmsComFracionado, v.rms)}</div><div className="l">{fmtNum(v.rmsComFracionado)} de {fmtNum(v.rms)} RMs têm ao menos 1 item fracionado</div></div>
      </div>

      <div className="card">
        <h2>Grupos de pedidos fracionados (pela sobra após as caixas fechadas)</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>Grupo</th><th className="n">Pedidos</th><th className="n">% dos fracionados</th><th className="n">% de todos os pedidos</th><th className="n">Unid. da sobra</th><th className="n">Sobra média</th></tr>
            </thead>
            <tbody>
              {grupos.map((g) => {
                const x = v.porGrupo[g];
                return (
                  <tr key={g}>
                    <td>{NOME_GRUPO[g]}</td>
                    <td className="n">{fmtNum(x.n)}</td>
                    <td className="n">{pct(x.n, v.fracionadas)}</td>
                    <td className="n">{pct(x.n, v.linhas)}</td>
                    <td className="n">{fmtNum(x.unidadesSobra)}</td>
                    <td className="n">{x.n ? fmtNum(x.unidadesSobra / x.n) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          A sobra é a quantidade que resta depois de tirar as caixas fechadas (ex.: pedido 45 com caixa de 20 → 2 caixas + sobra 5 = 25% da caixa → G3).
        </p>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>% de pedidos fracionados por mês</h2>
          {meses.map((m) => {
            const p = m.linhas ? m.fracionadas / m.linhas : 0;
            return (
              <div className="hbar wide" key={m.mes} title={`${fmtNum(m.fracionadas)} de ${fmtNum(m.linhas)} pedidos`}>
                <span className="small">{m.mes}</span>
                <div className="track" aria-hidden><i className="b" style={{ width: `${(p / maxPct) * 100}%`, background: "var(--warn)" }} /></div>
                <span className="val">{pct(m.fracionadas, m.linhas)} <span className="muted small">({fmtNum(m.fracionadas)}/{fmtNum(m.linhas)})</span></span>
              </div>
            );
          })}
          <p className="muted small">Média histórica no período: <strong>{pct(v.fracionadas, v.linhas)}</strong>. Mostrando os últimos {meses.length} meses.</p>
        </div>

        <div className="card">
          <h2>PIs com mais pedidos fracionados</h2>
          <div className="chips" style={{ marginBottom: 8 }} role="group" aria-label="Grupo">
            {([0, 1, 2, 3] as const).map((g) => (
              <button key={g} className="chip" aria-pressed={grupoSel === g} onClick={() => setGrupoSel(g)}>
                {g === 0 ? "Todos" : `G${g}`}
              </button>
            ))}
          </div>
          <div className="tablewrap" style={{ maxHeight: 420 }}>
            <table>
              <thead><tr><th>PI</th><th>Descrição</th><th className="n">Pedidos</th><th className="n">Unid.</th></tr></thead>
              <tbody>
                {v.topPis[grupoSel].map((x) => (
                  <tr key={x.pi}>
                    <td>{x.pi}</td><td className="wrapc">{x.desc}</td>
                    <td className="n">{fmtNum(x.n)}</td><td className="n">{fmtNum(x.unidades)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Reposição */

type Salvo = { params: ParamsRepo; caixasPorPi: Record<string, number> };

const JANELAS = [
  { v: 30, nome: "30 dias" }, { v: 60, nome: "60 dias" }, { v: 90, nome: "90 dias" },
  { v: 180, nome: "180 dias" }, { v: 365, nome: "12 meses" }, { v: 0, nome: "Todo o histórico" },
];

const ROTULO = { critico: "CRÍTICO", atencao: "ATENÇÃO", ok: "OK" } as const;
const TOM = { critico: "bad", atencao: "warn", ok: "ok" } as const;

function Reposicao({ rm, estoque }: { rm: RmDados; estoque: Dados | null }) {
  const [s, setS] = useState<Salvo>({ params: PARAMS_PADRAO, caixasPorPi: {} });
  const [pronto, setPronto] = useState(false);
  const [q, setQ] = useState("");
  const [filtro, setFiltro] = useState<"alertas" | "todos" | "loc">("alertas");
  const [aberto, setAberto] = useState<string | null>(null);

  useEffect(() => {
    setS(lerLS({ params: PARAMS_PADRAO, caixasPorPi: {} }));
    setPronto(true);
  }, []);
  useEffect(() => {
    if (!pronto) return;
    try { localStorage.setItem(CHAVE_LS, JSON.stringify(s)); } catch { /* sem armazenamento */ }
  }, [s, pronto]);

  const est = useMemo(() => estoquePorPi(estoque), [estoque]);
  const { itens, janelaDias, ultimoDia } = useMemo(() => calcReposicao(rm, est, s.params, s.caixasPorPi), [rm, est, s]);

  const lista = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return itens.filter((i) => {
      if (filtro === "alertas" && i.situacao === "ok") return false;
      if (filtro === "loc" && !i.locInsuficiente) return false;
      if (toks.length) {
        const h = norm(`${i.pi} ${i.desc}`);
        if (!toks.every((t) => h.includes(t))) return false;
      }
      return true;
    });
  }, [itens, q, filtro]);

  const cont = useMemo(() => ({
    critico: itens.filter((i) => i.situacao === "critico").length,
    atencao: itens.filter((i) => i.situacao === "atencao").length,
    loc: itens.filter((i) => i.locInsuficiente).length,
  }), [itens]);

  const setP = <K extends keyof ParamsRepo>(k: K, v: ParamsRepo[K]) => setS((o) => ({ ...o, params: { ...o.params, [k]: v } }));
  const setCx = (pi: string, v: number) =>
    setS((o) => {
      const c = { ...o.caixasPorPi };
      if (v > 0 && v !== o.params.caixasLoc) c[pi] = v; else delete c[pi];
      return { ...o, caixasPorPi: c };
    });

  function exportar() {
    const cab = ["PI", "Descrição", "CXP", "Pedidos fracionados", "Média/dia", "Estoque FR", "Estoque SC", "Cobertura FR (dias)", "Situação", "Caixas/LOC", "LOC comporta a meta", "Caixas a repor"];
    const corpo = lista.map((i) => [i.pi, i.desc, i.cxp, i.pedidosFr, i.media.toFixed(2).replace(".", ","), i.estFr, i.estSc, Number.isFinite(i.cobertura) ? i.cobertura.toFixed(1).replace(".", ",") : "", ROTULO[i.situacao], i.caixasLoc, i.locInsuficiente ? "NÃO" : "SIM", i.caixasRepor]);
    const blob = new Blob(["﻿" + csv([cab, ...corpo])], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "reposicao-fr.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      {!estoque && <div className="note">O estoque ainda não foi carregado; as quantidades em FR/SC aparecem zeradas até ele carregar.</div>}
      <section className="card filters" aria-label="Parâmetros da reposição">
        <label>
          Janela da média de consumo
          <select value={s.params.janela} onChange={(e) => setP("janela", +e.target.value)}>
            {JANELAS.map((j) => <option key={j.v} value={j.v}>{j.nome}</option>)}
          </select>
        </label>
        <label>
          Cobertura desejada no FR (dias)
          <input type="number" min={1} value={s.params.diasAlvo} style={{ width: 90 }}
            onChange={(e) => setP("diasAlvo", Math.max(1, +e.target.value || 1))} />
        </label>
        <label>
          Caixas por LOC FR (padrão)
          <input type="number" min={1} value={s.params.caixasLoc} style={{ width: 90 }}
            onChange={(e) => setP("caixasLoc", Math.max(1, +e.target.value || 1))} />
        </label>
        <label>
          Consumo do FR considera
          <select value={s.params.base} onChange={(e) => setP("base", e.target.value as ParamsRepo["base"])}>
            <option value="total">Quantidade total do pedido fracionado</option>
            <option value="sobra">Somente a sobra (após caixas fechadas)</option>
          </select>
        </label>
        <label>
          Mín. de pedidos fracionados
          <input type="number" min={1} value={s.params.minPedidos} style={{ width: 90 }}
            onChange={(e) => setP("minPedidos", Math.max(1, +e.target.value || 1))} />
        </label>
        <span className="muted small" style={{ flexBasis: "100%" }}>
          Média calculada sobre {fmtNum(janelaDias)} dias até {ultimoDia ? diaParaData(ultimoDia) : "—"}. Os ajustes ficam salvos neste navegador.
          {Object.keys(s.caixasPorPi).length > 0 && (
            <> {fmtNum(Object.keys(s.caixasPorPi).length)} PI(s) com caixas/LOC personalizadas · <button className="btn" onClick={() => setS((o) => ({ ...o, caixasPorPi: {} }))}>Voltar tudo ao padrão</button></>
          )}
        </span>
      </section>

      <div className="grid g4">
        <div className="card kpi bad"><div className="v">{fmtNum(cont.critico)}</div><div className="l">PIs críticos (FR zerado ou menos de 40% da meta)</div></div>
        <div className="card kpi warn"><div className="v">{fmtNum(cont.atencao)}</div><div className="l">PIs em atenção (abaixo da meta de cobertura)</div></div>
        <div className="card kpi"><div className="v">{fmtNum(cont.loc)}</div><div className="l">PIs em que a LOC cheia não cobre a meta</div></div>
        <div className="card kpi"><div className="v">{fmtNum(itens.length)}</div><div className="l">PIs com demanda fracionada analisados</div></div>
      </div>

      <div className="card">
        <div className="bar" style={{ justifyContent: "space-between" }}>
          <div className="seg" role="group" aria-label="Filtro">
            <button aria-pressed={filtro === "alertas"} onClick={() => setFiltro("alertas")}>Só alertas</button>
            <button aria-pressed={filtro === "loc"} onClick={() => setFiltro("loc")}>LOC não comporta</button>
            <button aria-pressed={filtro === "todos"} onClick={() => setFiltro("todos")}>Todos</button>
          </div>
          <input type="search" placeholder="Buscar PI ou nome" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <button className="btn" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Situação</th><th>PI</th><th>Descrição</th><th className="n">Caixa</th><th className="n">Média/dia</th>
                <th className="n">Estoque FR</th><th className="n">Cobertura</th><th className="n">Caixas/LOC</th><th className="n">Repor (caixas)</th><th className="n">Estoque SC</th>
              </tr>
            </thead>
            <tbody>
              {lista.slice(0, 300).map((i) => (
                <LinhaRepo key={i.pi} i={i} dias={s.params.diasAlvo} aberto={aberto === i.pi} onToggle={() => setAberto(aberto === i.pi ? null : i.pi)} onCx={(v) => setCx(i.pi, v)} />
              ))}
            </tbody>
          </table>
        </div>
        {lista.length > 300 && <p className="muted small">Mostrando 300 de {fmtNum(lista.length)}. Refine pela busca ou use Exportar CSV.</p>}
        {lista.length === 0 && <p className="muted">Nenhum PI neste filtro.</p>}
      </div>
    </>
  );
}

function LinhaRepo({ i, dias, aberto, onToggle, onCx }: { i: ItemRepo; dias: number; aberto: boolean; onToggle: () => void; onCx: (v: number) => void }) {
  return (
    <>
      <tr className="click" onClick={onToggle}>
        <td>
          <span className={`tag ${TOM[i.situacao]}`}>{ROTULO[i.situacao]}</span>
          {i.locInsuficiente && <span className="tag neutral" style={{ marginLeft: 4 }} title="A LOC cheia não cobre a meta de dias">LOC</span>}
        </td>
        <td>{aberto ? "▾" : "▸"} {i.pi}</td>
        <td className="wrapc">{i.desc}</td>
        <td className="n">{fmtNum(i.cxp)}</td>
        <td className="n">{fmtNum(Math.round(i.media * 10) / 10)}</td>
        <td className="n">{fmtNum(i.estFr)}</td>
        <td className="n">{Number.isFinite(i.cobertura) ? `${fmtNum(Math.round(i.cobertura * 10) / 10)} d` : "—"}</td>
        <td className="n" onClick={(e) => e.stopPropagation()}>
          <input type="number" min={1} value={i.caixasLoc} style={{ width: 64, padding: "3px 6px" }} aria-label={`Caixas por LOC do PI ${i.pi}`}
            onChange={(e) => onCx(+e.target.value)} />
        </td>
        <td className="n"><strong>{i.caixasRepor > 0 ? fmtNum(i.caixasRepor) : "—"}</strong></td>
        <td className="n" style={i.faltaSc ? { color: "var(--bad)" } : undefined}>{fmtNum(i.estSc)}</td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={10}>
            <p style={{ margin: "4px 0" }}>
              {fmtNum(i.pedidosFr)} pedidos fracionados na janela ({fmtNum(i.unidadesFr)} un). Meta de {dias} dias = {fmtNum(i.caixasNecessarias)} caixas. LOCs FR atuais: {i.locsFr}.
            </p>
            <div className="grade" aria-label="Opções de caixas na LOC">
              {i.opcoes.map((o) => (
                <span key={o.caixas} style={o.dias < dias ? { borderColor: "var(--bad)" } : undefined}>
                  <b>{fmtNum(o.caixas)} caixas</b> ({fmtNum(o.caixas * i.cxp)} un) → {fmtNum(Math.round(o.dias * 10) / 10)} dias
                </span>
              ))}
            </div>
            {i.sugestoes.length > 0 && <ul style={{ margin: "4px 0 8px 18px", padding: 0 }}>{i.sugestoes.map((t, k) => <li key={k}>{t}</li>)}</ul>}
          </td>
        </tr>
      )}
    </>
  );
}
