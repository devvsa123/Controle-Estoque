"use client";

import { useEffect, useMemo, useState } from "react";
import type { RmDados } from "@/lib/rm";
import type { Dados } from "@/lib/types";
import { NOME_DEPOSITO } from "@/lib/config";
import { estatisticas, infoPedidos, montarLayout, simular, type LinhaSim, type LocFr, type PiFr } from "@/lib/layoutFr";
import { csv, fmtNum, norm } from "@/lib/util";

type Sub = "geral" | "locs" | "pis" | "sim";

const CHAVE_LS = "controle-estoque:rm:v2"; // mesma chave da aba Análise de RM (caixas por LOC)
const POR_PAGINA = 100;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—");

function lerCaixas(): { caixasLoc: number; caixasPorPi: Record<string, number> } {
  try {
    const j = JSON.parse(localStorage.getItem(CHAVE_LS) || "{}");
    return { caixasLoc: j?.params?.caixasLoc > 0 ? j.params.caixasLoc : 15, caixasPorPi: j?.caixasPorPi ?? {} };
  } catch {
    return { caixasLoc: 15, caixasPorPi: {} };
  }
}

function gravarCaixasLoc(v: number) {
  try {
    const j = JSON.parse(localStorage.getItem(CHAVE_LS) || "{}");
    localStorage.setItem(CHAVE_LS, JSON.stringify({ ...j, params: { ...(j.params ?? {}), caixasLoc: v } }));
  } catch { /* sem armazenamento */ }
}

export default function LayoutFr({ estoque }: { estoque: Dados | null }) {
  const [sub, setSub] = useState<Sub>("geral");
  const [incluirBloq, setIncluirBloq] = useState(true);
  const [deps, setDeps] = useState<string[]>([]);
  const [caixas, setCaixas] = useState({ caixasLoc: 15, caixasPorPi: {} as Record<string, number> });
  const [janela, setJanela] = useState(365);
  const [rm, setRm] = useState<RmDados | null>(null);
  const [rmErro, setRmErro] = useState<string | null>(null);

  useEffect(() => setCaixas(lerCaixas()), []);
  useEffect(() => {
    let vivo = true;
    fetch("/api/rm", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.erro || "Falha ao carregar os pedidos");
        if (j.faltando?.length) throw new Error(`A planilha de pedidos não tem as colunas ${j.faltando.join(", ")}`);
        if (vivo) setRm(j);
      })
      .catch((e) => vivo && setRmErro(e instanceof Error ? e.message : "Falha ao carregar os pedidos"));
    return () => { vivo = false; };
  }, []);

  const depsDisponiveis = useMemo(() => {
    if (!estoque) return [];
    return [...new Set(estoque.linhas.filter((l) => estoque.escopos[l.dep] === "estoque" && l.area === "FR" && l.dep !== "P04").map((l) => l.dep))].sort();
  }, [estoque]);

  const lay = useMemo(() => (estoque ? montarLayout(estoque, incluirBloq, deps) : null), [estoque, incluirBloq, deps]);
  const est = useMemo(() => (lay ? estatisticas(lay) : null), [lay]);
  const info = useMemo(() => (rm ? infoPedidos(rm, janela) : null), [rm, janela]);

  if (!estoque || !lay || !est) return <p className="muted">Aguardando a planilha de estoque…</p>;
  const t = est.total;
  const descPi = (pi: string) => estoque.produtos[pi]?.desc ?? pi;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <p className="muted small" style={{ margin: 0 }}>
        LOCs da área <strong>FR</strong> dos paiois P01, P02, P03 e P05 (o P04 fica de fora). Uma LOC é a combinação paiol + endereço. A planilha só mostra LOCs que têm saldo; LOCs FR
        vazias não aparecem aqui.
      </p>

      <section className="card filters" aria-label="Filtros do layout">
        <div className="chips" role="group" aria-label="Paiol">
          <span className="muted small" style={{ alignSelf: "center" }}>Paiol:</span>
          {depsDisponiveis.map((d) => (
            <button key={d} className="chip" title={NOME_DEPOSITO[d]} aria-pressed={deps.includes(d)} onClick={() => setDeps(deps.includes(d) ? deps.filter((x) => x !== d) : [...deps, d])}>{d}</button>
          ))}
          {deps.length > 0 && <button className="btn small" onClick={() => setDeps([])}>Todos</button>}
        </div>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={incluirBloq} onChange={(e) => setIncluirBloq(e.target.checked)} />
          Incluir saldo bloqueado (ocupa a LOC do mesmo jeito)
        </label>
        <label>
          Caixas por LOC FR (padrão)
          <input type="number" min={1} value={caixas.caixasLoc} style={{ width: 90 }}
            onChange={(e) => { const v = Math.max(1, +e.target.value || 1); setCaixas((c) => ({ ...c, caixasLoc: v })); gravarCaixasLoc(v); }} />
        </label>
        <label>
          Giro fracionado considerado
          <select value={janela} onChange={(e) => setJanela(+e.target.value)}>
            <option value={90}>Últimos 90 dias</option>
            <option value={180}>Últimos 6 meses</option>
            <option value={365}>Últimos 12 meses</option>
            <option value={0}>Todo o histórico</option>
          </select>
        </label>
        <span className="muted small" style={{ flexBasis: "100%" }}>
          {rm ? `Pedidos carregados (${fmtNum(rm.resumo.validas)} linhas): caixa padrão e giro fracionado vêm daí.` : rmErro ? `Sem os pedidos (${rmErro}): a capacidade das LOCs fica desconhecida.` : "Carregando os pedidos para obter a caixa padrão e o giro…"}
        </span>
      </section>

      <div className="seg" role="group" aria-label="Visão" style={{ justifySelf: "start" }}>
        <button aria-pressed={sub === "geral"} onClick={() => setSub("geral")}>Visão geral</button>
        <button aria-pressed={sub === "locs"} onClick={() => setSub("locs")}>LOCs com mais de um PI</button>
        <button aria-pressed={sub === "pis"} onClick={() => setSub("pis")}>PIs em várias LOCs</button>
        <button aria-pressed={sub === "sim"} onClick={() => setSub("sim")}>1 PI por LOC</button>
      </div>

      {sub === "geral" && (
        <>
          <div className="grid g4">
            <div className="card kpi"><div className="v">{fmtNum(t.locs)}</div><div className="l">LOCs FR com saldo · {fmtNum(t.pis)} PIs distintos</div></div>
            <div className="card kpi warn"><div className="v">{fmtNum(t.locsMulti)}</div><div className="l">LOCs com mais de um PI ({pct(t.locsMulti, t.locs)})</div></div>
            <div className="card kpi"><div className="v">{fmtNum(t.unidadesEmMulti)}</div><div className="l">Unidades nessas LOCs ({pct(t.unidadesEmMulti, t.unidades)} do total de {fmtNum(t.unidades)})</div></div>
            <div className="card kpi bad"><div className="v">{fmtNum(t.pisEmVariasLocs)}</div><div className="l">PIs em mais de uma LOC ({pct(t.pisEmVariasLocs, t.pis)}) · {fmtNum(est.pisEmVariosPaiois)} em mais de um paiol</div></div>
          </div>

          <div className="card">
            <h2>Por paiol</h2>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Paiol</th><th className="n">LOCs</th><th className="n">PIs</th><th className="n">LOCs c/ +1 PI</th><th className="n">% das LOCs</th><th className="n">PIs/LOC (média)</th><th className="n">Máx. PIs/LOC</th>
                    <th className="n">PIs em +1 LOC</th><th className="n">Unidades</th><th className="n" title="Pares PI×LOC menos LOCs: cada LOC mantém um PI">Movimentos mín.</th><th className="n">Unid. a mover</th>
                  </tr>
                </thead>
                <tbody>
                  {[...est.porPaiol, est.total].map((r) => (
                    <tr key={r.dep} style={r.dep === "TOTAL" ? { fontWeight: 700 } : undefined}>
                      <td title={NOME_DEPOSITO[r.dep]}>{r.dep === "TOTAL" ? "Total FR" : r.dep}</td>
                      <td className="n">{fmtNum(r.locs)}</td><td className="n">{fmtNum(r.pis)}</td><td className="n">{fmtNum(r.locsMulti)}</td>
                      <td className="n">{pct(r.locsMulti, r.locs)}</td><td className="n">{fmtNum(Math.round(r.mediaPis * 100) / 100)}</td><td className="n">{fmtNum(r.maxPis)}</td>
                      <td className="n">{fmtNum(r.pisEmVariasLocs)}</td><td className="n">{fmtNum(r.unidades)}</td><td className="n">{fmtNum(r.movimentosMin)}</td><td className="n">{fmtNum(r.unidadesAMover)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              <strong>Movimentos mín.</strong>: em cada LOC com mais de um PI, só o de maior saldo fica e os outros saem (estimativa mínima, sem contar juntar PIs espalhados).{" "}
              <strong>Unid. a mover</strong>: soma do saldo dos PIs que sairiam.
            </p>
          </div>

          <div className="grid g2">
            <div className="card">
              <h2>Quantos PIs há em cada LOC</h2>
              {est.distPisPorLoc.map((f) => (
                <div className="hbar wide" key={f.rotulo}>
                  <span className="small">{f.rotulo}</span>
                  <div className="track" aria-hidden><i className="b" style={{ width: `${(f.locs / Math.max(1, t.locs)) * 100}%`, background: f.rotulo === "1 PI" ? "var(--ok)" : "var(--warn)" }} /></div>
                  <span className="val">{fmtNum(f.locs)} LOCs <span className="muted small">({pct(f.locs, t.locs)} · {fmtNum(f.unidades)} un)</span></span>
                </div>
              ))}
            </div>
            <div className="card">
              <h2>Em quantas LOCs FR cada PI aparece</h2>
              {est.distLocsPorPi.map((f) => (
                <div className="hbar wide" key={f.rotulo}>
                  <span className="small">{f.rotulo}</span>
                  <div className="track" aria-hidden><i className="b" style={{ width: `${(f.pis / Math.max(1, t.pis)) * 100}%`, background: f.rotulo === "1 LOC" ? "var(--ok)" : "var(--warn)" }} /></div>
                  <span className="val">{fmtNum(f.pis)} PIs <span className="muted small">({pct(f.pis, t.pis)} · {fmtNum(f.unidades)} un)</span></span>
                </div>
              ))}
            </div>
          </div>

          <details className="card">
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Por rua ({fmtNum(est.porRua.length)} ruas)</summary>
            <div className="tablewrap" style={{ maxHeight: 420, marginTop: 8 }}>
              <table>
                <thead><tr><th>Paiol</th><th>Rua</th><th className="n">LOCs</th><th className="n">LOCs c/ +1 PI</th><th className="n">% c/ +1 PI</th><th className="n">PIs</th><th className="n">Unidades</th></tr></thead>
                <tbody>
                  {est.porRua.map((r) => (
                    <tr key={r.dep + r.rua}><td>{r.dep}</td><td>{r.rua}</td><td className="n">{fmtNum(r.locs)}</td><td className="n">{fmtNum(r.locsMulti)}</td><td className="n">{pct(r.locsMulti, r.locs)}</td><td className="n">{fmtNum(r.pis)}</td><td className="n">{fmtNum(r.unidades)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      {sub === "locs" && <LocsMulti locs={lay.locs} pis={lay.pis} descPi={descPi} info={info} />}
      {sub === "pis" && <PisEspalhados pis={[...lay.pis.values()]} descPi={descPi} info={info} caixas={caixas} />}
      {sub === "sim" && <Simulacao lay={lay} info={info} caixas={caixas} descPi={descPi} janela={janela} temRm={!!rm} />}
    </div>
  );
}

/* ---------------------------------------------------------- LOCs com mais de um PI */

function Paginador({ total, pag, setPag }: { total: number; pag: number; setPag: (n: number) => void }) {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  return (
    <div className="pager">
      <span className="muted small">{total === 0 ? "Nenhum resultado" : `${fmtNum(pag * POR_PAGINA + 1)}–${fmtNum(Math.min(total, (pag + 1) * POR_PAGINA))} de ${fmtNum(total)}`}</span>
      <span style={{ display: "flex", gap: 6 }}>
        <button disabled={pag === 0} onClick={() => setPag(pag - 1)}>← Anterior</button>
        <button disabled={pag >= paginas - 1} onClick={() => setPag(pag + 1)}>Próxima →</button>
      </span>
    </div>
  );
}

function baixar(nome: string, cab: string[], corpo: (string | number)[][]) {
  const blob = new Blob(["﻿" + csv([cab, ...corpo])], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

function LocsMulti({ locs, pis, descPi, info }: { locs: LocFr[]; pis: Map<string, PiFr>; descPi: (pi: string) => string; info: ReturnType<typeof infoPedidos> | null }) {
  const [min, setMin] = useState(2);
  const [q, setQ] = useState("");
  const [pag, setPag] = useState(0);
  const [aberto, setAberto] = useState<string | null>(null);

  const lista = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return locs
      .filter((l) => l.itens.length >= min)
      .filter((l) => !toks.length || toks.every((t) => norm(`${l.end} ${l.itens.map((i) => `${i.pi} ${descPi(i.pi)}`).join(" ")}`).includes(t)))
      .sort((a, b) => b.itens.length - a.itens.length || b.qtd - a.qtd);
  }, [locs, min, q, descPi]);
  useEffect(() => setPag(0), [min, q, locs]);
  const pagina = lista.slice(pag * POR_PAGINA, (pag + 1) * POR_PAGINA);

  return (
    <div className="card">
      <div className="bar" style={{ justifyContent: "space-between" }}>
        <label className="muted small">Mínimo de PIs na LOC{" "}
          <select value={min} onChange={(e) => setMin(+e.target.value)}>
            {[2, 3, 4, 5, 8, 10].map((n) => <option key={n} value={n}>{n}+</option>)}
          </select>
        </label>
        <input type="search" placeholder="Buscar endereço, PI ou nome" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240, flex: "1 1 240px" }} />
        <button className="btn" disabled={!lista.length} onClick={() => baixar("locs-fr-multi-pi.csv", ["Paiol", "Endereço", "Nº de PIs", "Unidades", "PI", "Descrição", "Saldo do PI", "Bloqueado", "PI em quantas LOCs FR"],
          lista.flatMap((l) => l.itens.map((i) => [l.dep, l.end, l.itens.length, String(l.qtd).replace(".", ","), i.pi, descPi(i.pi), String(i.qtd).replace(".", ","), String(i.bloq).replace(".", ","), pis.get(i.pi)?.locs.length ?? 1])))}>
          Exportar CSV
        </button>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Paiol</th><th>Endereço</th><th className="n">PIs</th><th className="n">Unidades</th><th>PI dominante</th><th className="n">% do saldo da LOC</th></tr></thead>
          <tbody>
            {pagina.map((l) => {
              const dom = l.itens[0];
              return (
                <LocLinha key={l.loc} l={l} dom={dom} aberto={aberto === l.loc} onToggle={() => setAberto(aberto === l.loc ? null : l.loc)} pis={pis} descPi={descPi} info={info} />
              );
            })}
          </tbody>
        </table>
      </div>
      <Paginador total={lista.length} pag={pag} setPag={setPag} />
    </div>
  );
}

function LocLinha({ l, dom, aberto, onToggle, pis, descPi, info }: { l: LocFr; dom: LocFr["itens"][number]; aberto: boolean; onToggle: () => void; pis: Map<string, PiFr>; descPi: (pi: string) => string; info: ReturnType<typeof infoPedidos> | null }) {
  return (
    <>
      <tr className="click" onClick={onToggle}>
        <td>{l.dep}</td><td>{aberto ? "▾" : "▸"} {l.end}</td><td className="n"><strong>{l.itens.length}</strong></td><td className="n">{fmtNum(l.qtd)}</td>
        <td className="wrapc">{dom.pi} · {descPi(dom.pi)}</td><td className="n">{pct(dom.qtd, l.qtd)}</td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={6}>
            <table>
              <thead><tr><th>PI</th><th>Descrição</th><th className="n">Saldo na LOC</th><th className="n">Bloqueado</th><th className="n">LOCs FR do PI</th><th className="n">Caixa</th><th className="n">Caixas na LOC</th></tr></thead>
              <tbody>
                {l.itens.map((i) => {
                  const cx = info?.cxp.get(i.pi);
                  return (
                    <tr key={i.pi}>
                      <td>{i.pi}</td><td className="wrapc">{descPi(i.pi)}</td><td className="n">{fmtNum(i.qtd)}</td>
                      <td className="n">{i.bloq > 0 ? <span style={{ color: "var(--warn)" }}>{fmtNum(i.bloq)}</span> : "—"}</td>
                      <td className="n">{pis.get(i.pi)?.locs.length ?? 1}</td><td className="n">{cx ? fmtNum(cx) : "—"}</td><td className="n">{cx ? fmtNum(Math.round((i.qtd / cx) * 10) / 10) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

/* ---------------------------------------------------------- PIs em várias LOCs */

function PisEspalhados({ pis, descPi, info, caixas }: { pis: PiFr[]; descPi: (pi: string) => string; info: ReturnType<typeof infoPedidos> | null; caixas: { caixasLoc: number; caixasPorPi: Record<string, number> } }) {
  const [min, setMin] = useState(2);
  const [q, setQ] = useState("");
  const [pag, setPag] = useState(0);
  const [aberto, setAberto] = useState<string | null>(null);

  const linhas = useMemo(() => {
    return pis
      .filter((p) => p.locs.length >= min)
      .map((p) => {
        const cx = info?.cxp.get(p.pi);
        const cap = cx ? (caixas.caixasPorPi[p.pi] > 0 ? caixas.caixasPorPi[p.pi] : caixas.caixasLoc) * cx : null;
        const necessarias = cap ? Math.max(1, Math.ceil(p.qtd / cap - 1e-9)) : null;
        return { p, cx, cap, necessarias, liberaveis: necessarias !== null ? Math.max(0, p.locs.length - necessarias) : null };
      });
  }, [pis, min, info, caixas]);

  const lista = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return linhas
      .filter((x) => !toks.length || toks.every((t) => norm(`${x.p.pi} ${descPi(x.p.pi)}`).includes(t)))
      .sort((a, b) => (b.liberaveis ?? -1) - (a.liberaveis ?? -1) || b.p.locs.length - a.p.locs.length);
  }, [linhas, q, descPi]);
  useEffect(() => setPag(0), [min, q, pis]);
  const pagina = lista.slice(pag * POR_PAGINA, (pag + 1) * POR_PAGINA);
  const liberaveisTotal = lista.reduce((s, x) => s + (x.liberaveis ?? 0), 0);

  return (
    <div className="card">
      <div className="bar" style={{ justifyContent: "space-between" }}>
        <label className="muted small">PI em pelo menos{" "}
          <select value={min} onChange={(e) => setMin(+e.target.value)}>
            {[2, 3, 4, 5, 8].map((n) => <option key={n} value={n}>{n} LOCs</option>)}
          </select>
        </label>
        <input type="search" placeholder="Buscar PI ou nome" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220, flex: "1 1 220px" }} />
        <button className="btn" disabled={!lista.length} onClick={() => baixar("pis-fr-varias-locs.csv", ["PI", "Descrição", "LOCs FR", "Paióis", "Unidades", "Caixa", "LOCs necessárias", "LOCs liberáveis", "Endereços (saldo)"],
          lista.map((x) => [x.p.pi, descPi(x.p.pi), x.p.locs.length, x.p.deps.join(" "), String(x.p.qtd).replace(".", ","), x.cx ?? "", x.necessarias ?? "", x.liberaveis ?? "", x.p.locs.map((l) => `${l.dep} ${l.end} (${l.qtd})`).join(" | ")]))}>
          Exportar CSV
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {fmtNum(lista.length)} PIs · juntando cada PI no mínimo de LOCs que comporta ({caixas.caixasLoc} caixas por LOC) liberaria <strong>{fmtNum(liberaveisTotal)} LOCs</strong>{!info && " (carregando a caixa padrão…)"}.
      </p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>PI</th><th>Descrição</th><th className="n">LOCs FR</th><th>Paiol</th><th className="n">Unidades</th><th className="n">Caixa</th><th className="n">Cabe em</th><th className="n">LOCs liberáveis</th></tr></thead>
          <tbody>
            {pagina.map((x) => (
              <PiLinhaEsp key={x.p.pi} x={x} desc={descPi(x.p.pi)} aberto={aberto === x.p.pi} onToggle={() => setAberto(aberto === x.p.pi ? null : x.p.pi)} />
            ))}
          </tbody>
        </table>
      </div>
      <Paginador total={lista.length} pag={pag} setPag={setPag} />
    </div>
  );
}

function PiLinhaEsp({ x, desc, aberto, onToggle }: { x: { p: PiFr; cx: number | undefined; cap: number | null; necessarias: number | null; liberaveis: number | null }; desc: string; aberto: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="click" onClick={onToggle}>
        <td>{aberto ? "▾" : "▸"} {x.p.pi}</td><td className="wrapc">{desc}</td><td className="n"><strong>{x.p.locs.length}</strong></td><td>{x.p.deps.join(", ")}</td>
        <td className="n">{fmtNum(x.p.qtd)}</td><td className="n">{x.cx ? fmtNum(x.cx) : "—"}</td>
        <td className="n">{x.necessarias !== null ? `${x.necessarias} LOC${x.necessarias > 1 ? "s" : ""}` : <span className="muted">sem caixa</span>}</td>
        <td className="n">{x.liberaveis !== null ? <strong style={{ color: x.liberaveis > 0 ? "var(--ok)" : undefined }}>{x.liberaveis}</strong> : "—"}</td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={8}>
            <div className="grade">
              {x.p.locs.map((l) => <span key={l.loc}><b>{l.dep}</b> {l.end}: {fmtNum(l.qtd)}{x.cx ? ` (${fmtNum(Math.round((l.qtd / x.cx) * 10) / 10)} cx)` : ""}</span>)}
            </div>
            {x.cap && <p className="muted small" style={{ margin: "4px 0" }}>Capacidade de uma LOC: {fmtNum(x.cap)} un. Saldo total {fmtNum(x.p.qtd)} → {x.necessarias} LOC(s).</p>}
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------------------------------------- 1 PI por LOC */

function Simulacao({ lay, info, caixas, descPi, janela, temRm }: { lay: ReturnType<typeof montarLayout>; info: ReturnType<typeof infoPedidos> | null; caixas: { caixasLoc: number; caixasPorPi: Record<string, number> }; descPi: (pi: string) => string; janela: number; temRm: boolean }) {
  const todos = useMemo(() => simular(lay, info, { caixasLoc: caixas.caixasLoc, caixasPorPi: caixas.caixasPorPi, manter: null }), [lay, info, caixas]);
  const comGiro = useMemo(
    () => (info ? simular(lay, info, { caixasLoc: caixas.caixasLoc, caixasPorPi: caixas.caixasPorPi, manter: info.fracionadoNaJanela }) : null),
    [lay, info, caixas]
  );
  const semGiro = useMemo(() => {
    if (!info) return [];
    return [...lay.pis.values()].filter((p) => !info.fracionadoNaJanela.has(p.pi)).sort((a, b) => b.qtd - a.qtd);
  }, [lay, info]);
  const [pag, setPag] = useState(0);
  const pagina = semGiro.slice(pag * POR_PAGINA, (pag + 1) * POR_PAGINA);
  const nomeJanela = janela === 0 ? "todo o histórico" : janela === 365 ? "12 meses" : janela === 180 ? "6 meses" : "90 dias";

  return (
    <div className="grid" style={{ gap: 12 }}>
      <TabelaSim titulo="Cenário A · todos os PIs que hoje têm saldo no FR, 1 LOC por PI" linhas={todos} />
      {comGiro ? (
        <TabelaSim titulo={`Cenário B · só PIs com pedido fracionado em ${nomeJanela}, 1 LOC por PI`} linhas={comGiro} />
      ) : (
        <div className="note">{temRm ? "Calculando…" : "O cenário B (só PIs com giro fracionado) depende da planilha de pedidos, que não carregou."}</div>
      )}
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>
          <strong>Como ler:</strong> cada PI ocupa <strong>1 LOC de picking</strong>. “Saldo” = LOCs necessárias (uma por PI) menos as LOCs ocupadas hoje: <em>positivo</em> = faltariam LOCs FR
          vazias (a planilha não mostra quantas existem; confira no WMS); <em>negativo</em> = caberia e sobrariam LOCs. A capacidade de uma LOC é {caixas.caixasLoc} caixas × caixa padrão; o que passa disso
          é “excedente” e teria de ficar em SC/outro local. A última coluna de LOCs mostra, só para comparação, quantas LOCs seriam precisas se todo o saldo continuasse no FR. A capacidade real
          depende do tamanho e da altura de cada LOC, que não estão na planilha. PIs sem caixa padrão conhecida não têm excedente calculado.
        </p>
      </div>
      {info && (
        <div className="card">
          <h2>PIs com saldo no FR sem pedido fracionado em {nomeJanela} ({fmtNum(semGiro.length)})</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Candidatos a sair do FR (para SC ou outro local), o que libera LOCs para o cenário B.</p>
          <div className="bar" style={{ justifyContent: "flex-end" }}>
            <button className="btn" disabled={!semGiro.length} onClick={() => baixar("pis-fr-sem-giro.csv", ["PI", "Descrição", "LOCs FR", "Paióis", "Unidades", "Endereços"], semGiro.map((p) => [p.pi, descPi(p.pi), p.locs.length, p.deps.join(" "), String(p.qtd).replace(".", ","), p.locs.map((l) => `${l.dep} ${l.end} (${l.qtd})`).join(" | ")]))}>Exportar CSV</button>
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>PI</th><th>Descrição</th><th className="n">LOCs FR</th><th>Paiol</th><th className="n">Unidades</th></tr></thead>
              <tbody>
                {pagina.map((p) => (
                  <tr key={p.pi}><td>{p.pi}</td><td className="wrapc">{descPi(p.pi)}</td><td className="n">{p.locs.length}</td><td>{p.deps.join(", ")}</td><td className="n">{fmtNum(p.qtd)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginador total={semGiro.length} pag={pag} setPag={setPag} />
        </div>
      )}
    </div>
  );
}

function TabelaSim({ titulo, linhas }: { titulo: string; linhas: LinhaSim[] }) {
  const tot = linhas[linhas.length - 1];
  return (
    <div className="card">
      <h2>{titulo}</h2>
      <p style={{ margin: "0 0 8px" }}>
        {tot.saldo <= 0
          ? <>No FR inteiro <strong style={{ color: "var(--ok)" }}>caberia</strong>: {fmtNum(tot.locsUmPorPi)} PIs = {fmtNum(tot.locsUmPorPi)} LOCs, contra {fmtNum(tot.locsAtuais)} ocupadas hoje (sobrariam {fmtNum(-tot.saldo)}).</>
          : <>No FR inteiro <strong style={{ color: "var(--bad)" }}>faltariam {fmtNum(tot.saldo)} LOCs vazias</strong>: {fmtNum(tot.locsUmPorPi)} PIs = {fmtNum(tot.locsUmPorPi)} LOCs, contra {fmtNum(tot.locsAtuais)} ocupadas hoje.</>}
        {tot.pisComExcedente > 0 && <> Além disso, <strong>{fmtNum(tot.pisComExcedente)} PIs</strong> têm mais saldo do que uma LOC comporta (excedente de {fmtNum(tot.excedente)} un), que teria de ficar fora do FR.</>}
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Paiol</th><th className="n">LOCs hoje</th><th className="n">PIs considerados</th><th className="n">LOCs (1 por PI)</th><th className="n">Saldo</th>
              <th className="n">PIs c/ excedente</th><th className="n">Unid. excedentes</th><th className="n" title="Se todo o saldo de cada PI ficasse no FR, ocupando quantas LOCs forem precisas">LOCs se tudo ficasse no FR</th>
              <th className="n">PIs sem caixa</th><th className="n">PIs fora</th><th className="n">Unid. fora</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((r) => (
              <tr key={r.dep} style={r.dep === "TOTAL" ? { fontWeight: 700 } : undefined}>
                <td title={NOME_DEPOSITO[r.dep]}>{r.dep === "TOTAL" ? "Total FR (PI único)" : r.dep}</td>
                <td className="n">{fmtNum(r.locsAtuais)}</td><td className="n">{fmtNum(r.pisConsiderados)}</td><td className="n">{fmtNum(r.locsUmPorPi)}</td>
                <td className="n" style={{ color: r.saldo > 0 ? "var(--bad)" : "var(--ok)" }}>{r.saldo > 0 ? "+" : ""}{fmtNum(r.saldo)}</td>
                <td className="n">{fmtNum(r.pisComExcedente)}</td><td className="n">{fmtNum(r.excedente)}</td><td className="n">{fmtNum(r.locsSeTudoNoFr)}</td>
                <td className="n">{fmtNum(r.pisSemCxp)}</td><td className="n">{fmtNum(r.pisFora)}</td><td className="n">{fmtNum(r.unidadesFora)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
