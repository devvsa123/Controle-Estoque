"use client";

import { useEffect, useMemo, useState } from "react";
import type { RmDados } from "@/lib/rm";
import type { Dados } from "@/lib/types";
import {
  NOME_GRUPO, PARAMS_PADRAO, calcReposicao, diagnostico, estoquePorPi, visaoGeral,
  type Alocacao, type ItemRepo, type ParamsRepo,
} from "@/lib/rmAnalise";
import { csv, fmtDataHora, fmtNum, norm } from "@/lib/util";

type Sub = "geral" | "reposicao";

const CHAVE_LS = "controle-estoque:rm:v2";

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
  const [visReposicao, setVisReposicao] = useState(false); // monta a reposição na 1ª visita e mantém (preserva filtros)

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
          <button aria-pressed={sub === "reposicao"} onClick={() => { setVisReposicao(true); setSub("reposicao"); }}>Reposição do FR</button>
        </div>
        <span className="muted small">
          {fmtNum(rm.resumo.validas)} linhas de pedido · arquivo de {fmtDataHora(rm.atualizadoEm)}{rm.fonte === "local" ? " (local)" : ""} ·{" "}
          <button className="btn" onClick={carregar} disabled={carregando}>{carregando ? "Atualizando…" : "Recarregar"}</button>
        </span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Cada linha da planilha é um item de uma RM. Um pedido gera um lote de caixa fechada e/ou um lote <strong>fracionado</strong> com a sobra (ex.: 24 com caixa de 20 → 1 caixa + 4 un fracionadas); só a sobra consome o FR. Cancelados ficam de fora
        {rm.resumo.canceladas ? ` (${fmtNum(rm.resumo.canceladas)})` : ""}
        {rm.resumo.semQtd + rm.resumo.semCxp + rm.resumo.semData > 0
          ? `; ${fmtNum(rm.resumo.semQtd + rm.resumo.semCxp + rm.resumo.semData)} linhas sem QTD/CXP/data válidos também foram ignoradas`
          : ""}.
      </p>
      <div hidden={sub !== "geral"}><Geral rm={rm} /></div>
      {visReposicao && <div hidden={sub !== "reposicao"}><Reposicao rm={rm} estoque={estoque} /></div>}
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

const ROTULO = { critico: "FR ZERADO", atencao: "< 1 CAIXA", ok: "OK" } as const;
const TOM = { critico: "bad", atencao: "warn", ok: "ok" } as const;

function Reposicao({ rm, estoque }: { rm: RmDados; estoque: Dados | null }) {
  const [s, setS] = useState<Salvo>({ params: PARAMS_PADRAO, caixasPorPi: {} });
  const [pronto, setPronto] = useState(false);
  const [q, setQ] = useState("");
  const [filtro, setFiltro] = useState<"alertas" | "bloqueado" | "todos">("alertas");
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
  const { itens, janelaDias, ultimoDia, totais } = useMemo(() => calcReposicao(rm, est, s.params, s.caixasPorPi), [rm, est, s]);
  const diag = useMemo(() => diagnostico(rm), [rm]);

  const lista = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return itens.filter((i) => {
      if (filtro === "alertas" && i.situacao === "ok") return false;
      if (filtro === "bloqueado" && !(i.estSc <= 0 && i.bloq > 0)) return false;
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
    soBloq: itens.filter((i) => i.estSc <= 0 && i.bloq > 0).length,
  }), [itens]);

  const setP = <K extends keyof ParamsRepo>(k: K, v: ParamsRepo[K]) => setS((o) => ({ ...o, params: { ...o.params, [k]: v } }));
  const setCx = (pi: string, v: number) =>
    setS((o) => {
      const c = { ...o.caixasPorPi };
      if (v > 0 && v !== o.params.caixasLoc) c[pi] = v; else delete c[pi];
      return { ...o, caixasPorPi: c };
    });

  function exportar() {
    const cab = ["PI", "Descrição", "CXP", "Estoque FR", "Estoque SC", "Bloqueado", "Motivos do bloqueio", "Situação", "Caixas a repor", "Média por pedido (un)", "Frequência", "Pedidos fracionados (histórico)", "Último fracionado", "Caixas/LOC"];
    const corpo = lista.map((i) => [
      i.pi, i.desc, i.cxp, i.estFr, i.estSc, i.bloq,
      Object.entries(i.motivosBloq).map(([m, v]) => `${m}: ${v}`).join(" | "),
      ROTULO[i.situacao], i.caixasRepor, i.qtdMediaPedido.toFixed(1).replace(".", ","), i.freqTexto, i.pedidosFr, diaParaData(i.ultimoFr), i.caixasLoc,
    ]);
    const blob = new Blob(["\ufeff" + csv([cab, ...corpo])], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "reposicao-fr.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      {!estoque && <div className="note">O estoque ainda não foi carregado; as quantidades em FR/SC aparecem zeradas até ele carregar.</div>}
      <p className="muted small" style={{ margin: 0 }}>
        <strong>Regra do alerta:</strong> todo PI que já teve pedido fracionado precisa ter ao menos <strong>1 caixa padrão no FR</strong>. Ficam de fora os PIs com saldo no P04 e os que
        têm SC zerado <em>e</em> nada bloqueado. PIs com SC zerado mas com saldo bloqueado aparecem, com a quantidade bloqueada.
      </p>
      <section className="card filters" aria-label="Parâmetros">
        <label>
          Janela usada só nas alocações de 7 e 11 dias
          <select value={s.params.janela} onChange={(e) => setP("janela", +e.target.value)}>
            {JANELAS.map((j) => <option key={j.v} value={j.v}>{j.nome}</option>)}
          </select>
        </label>
        <label>
          Caixas por LOC FR (padrão)
          <input type="number" min={1} value={s.params.caixasLoc} style={{ width: 90 }}
            onChange={(e) => setP("caixasLoc", Math.max(1, +e.target.value || 1))} />
        </label>
        <span className="muted small" style={{ flexBasis: "100%" }}>
          Média calculada sobre {fmtNum(janelaDias)} dias até {ultimoDia ? diaParaData(ultimoDia) : "—"}. As caixas por LOC ficam salvas neste navegador.
          {Object.keys(s.caixasPorPi).length > 0 && (
            <> {fmtNum(Object.keys(s.caixasPorPi).length)} PI(s) personalizados · <button className="btn" onClick={() => setS((o) => ({ ...o, caixasPorPi: {} }))}>Voltar tudo ao padrão</button></>
          )}
        </span>
      </section>

      <div className="grid g4">
        <div className="card kpi bad"><div className="v">{fmtNum(cont.critico)}</div><div className="l">PIs com FR zerado</div></div>
        <div className="card kpi warn"><div className="v">{fmtNum(cont.atencao)}</div><div className="l">PIs com menos de 1 caixa no FR</div></div>
        <div className="card kpi"><div className="v">{fmtNum(cont.soBloq)}</div><div className="l">PIs com SC zerado e saldo bloqueado</div></div>
        <div className="card kpi"><div className="v">{fmtNum(itens.length)}</div><div className="l">PIs fracionados visíveis</div></div>
      </div>

      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Por que nem todos os PIs aparecem aqui? ({fmtNum(itens.length)} de {fmtNum(diag.pisTotal)} PIs)</summary>
        <table style={{ marginTop: 8 }}>
          <tbody>
            <tr><td>PIs distintos nos pedidos (sem cancelados)</td><td className="n">{fmtNum(diag.pisTotal)}</td></tr>
            <tr><td>Sem caixa padrão (CXP) válida — não dá para saber se foram fracionados</td><td className="n">{fmtNum(diag.semCxp)}</td></tr>
            <tr><td>Caixa padrão = 1 (unitária): todo pedido é múltiplo, nunca fraciona</td><td className="n">{fmtNum(diag.cxpUm)}</td></tr>
            <tr><td>Caixa padrão &gt; 1, mas todos os pedidos foram de caixas fechadas</td><td className="n">{fmtNum(diag.soCaixaFechada)}</td></tr>
            <tr><td><strong>Já tiveram pedido fracionado no histórico</strong></td><td className="n"><strong>{fmtNum(totais.fracionados)}</strong></td></tr>
            <tr><td>↳ ignorados por terem saldo no P04</td><td className="n">{fmtNum(totais.noP04)}</td></tr>
            <tr><td>↳ ignorados por SC zerado e nada bloqueado</td><td className="n">{fmtNum(totais.semScSemBloq)}</td></tr>
            <tr><td>↳ <strong>visíveis nesta tela</strong></td><td className="n"><strong>{fmtNum(totais.visiveis)}</strong></td></tr>
          </tbody>
        </table>
      </details>

      <div className="card">
        <div className="bar" style={{ justifyContent: "space-between" }}>
          <div className="seg" role="group" aria-label="Filtro">
            <button aria-pressed={filtro === "alertas"} onClick={() => setFiltro("alertas")}>Alertas (FR &lt; 1 caixa)</button>
            <button aria-pressed={filtro === "bloqueado"} onClick={() => setFiltro("bloqueado")}>SC zerado com bloqueio</button>
            <button aria-pressed={filtro === "todos"} onClick={() => setFiltro("todos")}>Todos</button>
          </div>
          <input type="search" placeholder="Buscar PI ou nome" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <button className="btn" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Situação</th><th>PI</th><th>Descrição</th><th className="n">Caixa</th><th className="n">Estoque FR</th>
                <th className="n">Estoque SC</th><th className="n">Bloqueado</th><th className="n">Repor (caixas)</th>
                <th className="n">Média por pedido</th><th>Frequência</th><th>Último fracionado</th><th className="n">Caixas/LOC</th><th>Alocação 7 dias</th><th>Alocação 11 dias</th>
              </tr>
            </thead>
            <tbody>
              {lista.slice(0, 300).map((i) => (
                <LinhaRepo key={i.pi} i={i} aberto={aberto === i.pi} onToggle={() => setAberto(aberto === i.pi ? null : i.pi)} onCx={(v) => setCx(i.pi, v)} />
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

function resumoAloc(a: Alocacao): string {
  return `${a.locs} ${a.locs === 1 ? "LOC" : "LOCs"} · ${a.caixas} cx${a.locs > 1 ? ` (${a.distribuicao.join("+")})` : ""}`;
}

function LinhaRepo({ i, aberto, onToggle, onCx }: { i: ItemRepo; aberto: boolean; onToggle: () => void; onCx: (v: number) => void }) {
  const semSc = i.estSc <= 0;
  return (
    <>
      <tr className="click" onClick={onToggle}>
        <td><span className={`tag ${TOM[i.situacao]}`}>{ROTULO[i.situacao]}</span></td>
        <td>{aberto ? "▾" : "▸"} {i.pi}</td>
        <td className="wrapc">{i.desc}</td>
        <td className="n">{fmtNum(i.cxp)}</td>
        <td className="n">{fmtNum(i.estFr)}</td>
        <td className="n" style={semSc || i.scInsuficiente ? { color: "var(--bad)" } : undefined}>{fmtNum(i.estSc)}</td>
        <td className="n">{i.bloq > 0 ? <strong style={{ color: "var(--warn)" }} title={Object.entries(i.motivosBloq).map(([m, v]) => `${m}: ${fmtNum(v)}`).join(" · ")}>{fmtNum(i.bloq)}</strong> : <span className="muted">0</span>}</td>
        <td className="n"><strong>{i.caixasRepor > 0 ? (semSc ? "sem SC" : fmtNum(i.caixasRepor)) : "—"}</strong></td>
        <td className="n">{fmtNum(Math.round(i.qtdMediaPedido * 10) / 10)} un</td>
        <td title={`Pedidos fracionados em ${i.mesesAtivos} de ${i.mesesSpan} meses`}>{i.freqTexto}</td>
        <td>{diaParaData(i.ultimoFr)}</td>
        <td className="n" onClick={(e) => e.stopPropagation()}>
          <input type="number" min={1} value={i.caixasLoc} style={{ width: 64, padding: "3px 6px" }} aria-label={`Caixas por LOC do PI ${i.pi}`}
            onChange={(e) => onCx(+e.target.value)} />
        </td>
        {[0, 1].map((k) => <td key={k} className="small">{i.alocacoes[k] ? resumoAloc(i.alocacoes[k]) : "—"}</td>)}
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={14}>
            <p style={{ margin: "4px 0" }}>
              {fmtNum(i.pedidosFr)} pedidos fracionados no histórico; último em {diaParaData(i.ultimoFr)}. LOCs FR atuais: {i.locsFr}.
              {Number.isFinite(i.cobertura) && <> Pela média, o FR atual dura {fmtNum(Math.round(i.cobertura * 10) / 10)} dias.</>}
            </p>
            {i.bloq > 0 && (
              <p style={{ margin: "4px 0" }}>
                Saldo bloqueado: <strong>{fmtNum(i.bloq)}</strong>{" "}
                {Object.entries(i.motivosBloq).map(([m, v]) => <span key={m} className="tag bad" style={{ marginRight: 4 }}>{m}: {fmtNum(v)}</span>)}
              </p>
            )}
            {i.situacao !== "ok" && semSc && i.bloq > 0 && (
              <p style={{ margin: "4px 0" }}>Sem saldo livre em SC para repor; a reposição depende de desbloquear parte do saldo bloqueado acima.</p>
            )}
            {i.alocacoes.length > 0 && (
              <table style={{ width: "auto", marginBottom: 8 }}>
                <thead><tr><th>Meta (pela média)</th><th className="n">Caixas</th><th className="n">LOCs FR</th><th>Distribuição por LOC (caixas)</th><th className="n">LOCs novas</th><th className="n">Trazer do SC (caixas)</th></tr></thead>
                <tbody>
                  {i.alocacoes.map((a) => (
                    <tr key={a.dias}>
                      <td>{a.dias} dias</td><td className="n">{fmtNum(a.caixas)} ({fmtNum(a.caixas * i.cxp)} un)</td><td className="n">{a.locs}</td>
                      <td>{a.distribuicao.join(" + ")}</td><td className="n">{a.locsNovas || "—"}</td><td className="n">{a.repor || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {i.opcoes.length > 0 && (
              <div className="grade" aria-label="Opções de caixas na LOC">
                {i.opcoes.map((o) => (
                  <span key={o.caixas}><b>{fmtNum(o.caixas)} caixas</b> ({fmtNum(o.caixas * i.cxp)} un) → {fmtNum(Math.round(o.dias * 10) / 10)} dias</span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
