"use client";

import { useEffect, useMemo, useState } from "react";
import type { Dados, Escopo, Linha } from "@/lib/types";
import AnaliseRM from "@/components/AnaliseRM";
import Bloqueios from "@/components/Bloqueios";
import { NOME_AREA, NOME_DEPOSITO } from "@/lib/config";
import { cmpVariante, csv, diasAte, fmtData, fmtDataHora, fmtNum, norm } from "@/lib/util";

type Aba = "resumo" | "produtos" | "posicoes";
type Validade = "todas" | "vencido" | "90" | "sem";

interface Filtros {
  q: string;
  deps: string[];
  area: string;
  status: "todos" | "livre" | "bloqueado";
  motivo: string;
  validade: Validade;
}

const FILTROS_INICIAIS: Filtros = { q: "", deps: [], area: "", status: "todos", motivo: "", validade: "todas" };
const ESCOPOS: { id: Escopo; nome: string }[] = [
  { id: "estoque", nome: "Estoque" },
  { id: "recebimento", nome: "Recebimento" },
  { id: "fora", nome: "Fora do controle" },
];

interface Agregado {
  livre: number;
  bloq: number;
  posicoes: number;
  deps: Record<string, number>; // quantidade livre+bloqueada por depósito
  motivos: Record<string, number>;
  validadeMin: string;
}

function novoAgg(): Agregado {
  return { livre: 0, bloq: 0, posicoes: 0, deps: {}, motivos: {}, validadeMin: "" };
}

function somar(a: Agregado, l: Linha) {
  if (l.livre) a.livre += l.disp;
  else {
    a.bloq += l.disp;
    const m = l.motivo || "SEM MOTIVO";
    a.motivos[m] = (a.motivos[m] || 0) + l.disp;
  }
  a.posicoes++;
  a.deps[l.dep] = (a.deps[l.dep] || 0) + l.disp;
  if (l.val && (!a.validadeMin || l.val < a.validadeMin)) a.validadeMin = l.val;
}

export default function Page() {
  const [modulo, setModulo] = useState<"estoque" | "rm" | "bloqueios">("estoque");
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetch("/api/estoque", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha ao carregar");
      setDados(j);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar");
    } finally {
      setCarregando(false);
    }
  }
  useEffect(() => {
    carregar();
  }, []);

  // Abas visitadas continuam montadas (só escondidas): trocar de aba não busca os dados de novo
  // nem perde filtros/buscas. Cada módulo só é montado (e só baixa seus dados) na primeira visita.
  const [visitados, setVisitados] = useState<Record<string, boolean>>({ estoque: true });
  const abrir = (m: "estoque" | "rm" | "bloqueios") => {
    setVisitados((v) => (v[m] ? v : { ...v, [m]: true }));
    setModulo(m);
  };

  return (
    <>
      <nav className="modnav">
        <div className="seg" role="group" aria-label="Módulo">
          <button aria-pressed={modulo === "estoque"} onClick={() => abrir("estoque")}>Estoque</button>
          <button aria-pressed={modulo === "rm"} onClick={() => abrir("rm")}>Análise de RM</button>
          <button aria-pressed={modulo === "bloqueios"} onClick={() => abrir("bloqueios")}>Bloqueios NAO ENCONTRADO</button>
        </div>
      </nav>
      <div hidden={modulo !== "estoque"}>
        <EstoqueView dados={dados} erro={erro} carregando={carregando} carregar={carregar} />
      </div>
      {visitados.rm && (
        <div className="wrap" style={{ paddingTop: 12 }} hidden={modulo !== "rm"}>
          <AnaliseRM estoque={dados} />
        </div>
      )}
      {visitados.bloqueios && (
        <div className="wrap" style={{ paddingTop: 12 }} hidden={modulo !== "bloqueios"}>
          <Bloqueios />
        </div>
      )}
    </>
  );
}

function EstoqueView({ dados, erro, carregando, carregar }: { dados: Dados | null; erro: string | null; carregando: boolean; carregar: () => void }) {
  const [escopo, setEscopo] = useState<Escopo>("estoque");
  const [aba, setAba] = useState<Aba>("resumo");
  const [f, setF] = useState<Filtros>(FILTROS_INICIAIS);

  const hoje = useMemo(() => new Date(), []);

  // Linhas do escopo selecionado (base para os filtros)
  const doEscopo = useMemo(() => {
    if (!dados) return [] as Linha[];
    return dados.linhas.filter((l) => (dados.escopos[l.dep] ?? "fora") === escopo);
  }, [dados, escopo]);

  const opcoes = useMemo(() => {
    const deps = new Set<string>(), areas = new Set<string>(), motivos = new Set<string>();
    for (const l of doEscopo) {
      deps.add(l.dep);
      if (l.area) areas.add(l.area);
      if (!l.livre) motivos.add(l.motivo || "SEM MOTIVO");
    }
    return { deps: [...deps].sort(), areas: [...areas].sort(), motivos: [...motivos].sort() };
  }, [doEscopo]);

  // índice de busca por linha
  const hay = useMemo(() => {
    if (!dados) return new Map<Linha, string>();
    const m = new Map<Linha, string>();
    for (const l of dados.linhas) {
      const p = dados.produtos[l.pi];
      m.set(l, norm(`${l.pi} ${p?.desc ?? ""} ${l.end} ${l.lote} ${l.id} ${l.forn}`));
    }
    return m;
  }, [dados]);

  const filtradas = useMemo(() => {
    const toks = norm(f.q).split(/\s+/).filter(Boolean);
    return doEscopo.filter((l) => {
      if (f.deps.length && !f.deps.includes(l.dep)) return false;
      if (f.area && l.area !== f.area) return false;
      if (f.status === "livre" && !l.livre) return false;
      if (f.status === "bloqueado" && l.livre) return false;
      if (f.motivo && (l.livre || (l.motivo || "SEM MOTIVO") !== f.motivo)) return false;
      if (f.validade !== "todas") {
        if (f.validade === "sem") {
          if (l.val) return false;
        } else {
          if (!l.val) return false;
          const d = diasAte(l.val, hoje);
          if (f.validade === "vencido" && d >= 0) return false;
          if (f.validade === "90" && (d < 0 || d > 90)) return false;
        }
      }
      if (toks.length) {
        const h = hay.get(l) ?? "";
        for (const t of toks) if (!h.includes(t)) return false;
      }
      return true;
    });
  }, [doEscopo, f, hay, hoje]);

  const set = <K extends keyof Filtros>(k: K, v: Filtros[K]) => setF((o) => ({ ...o, [k]: v }));
  const filtrosAtivos = JSON.stringify({ ...f, q: "" }) !== JSON.stringify({ ...FILTROS_INICIAIS, q: "" }) || f.q !== "";

  function trocarEscopo(e: Escopo) {
    setEscopo(e);
    setF((o) => ({ ...o, deps: [], area: "", motivo: "" }));
  }

  if (erro)
    return (
      <div className="wrap">
        <div className="card err">
          <strong>Não foi possível carregar o estoque.</strong>
          <p>{erro}</p>
          <button className="btn" onClick={carregar}>Tentar novamente</button>
        </div>
      </div>
    );
  if (!dados)
    return (
      <div className="wrap">
        <p className="muted">{carregando ? "Carregando planilha de estoque…" : ""}</p>
      </div>
    );

  return (
    <div className="wrap">
      <header className="top">
        <h1>Controle de Estoque</h1>
        <span className="muted small">
          Planilha de {fmtDataHora(dados.atualizadoEm)}
          {dados.fonte === "local" ? " (arquivo local)" : ""} ·{" "}
          <button className="btn" onClick={carregar} disabled={carregando}>
            {carregando ? "Atualizando…" : "Recarregar"}
          </button>
        </span>
      </header>

      <div className="bar">
        <div className="seg" role="group" aria-label="Escopo">
          {ESCOPOS.map((e) => (
            <button key={e.id} aria-pressed={escopo === e.id} onClick={() => trocarEscopo(e.id)}>
              {e.nome}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Visão">
          {(["resumo", "produtos", "posicoes"] as Aba[]).map((a) => (
            <button key={a} aria-pressed={aba === a} onClick={() => setAba(a)}>
              {a === "resumo" ? "Resumo" : a === "produtos" ? "Produtos" : "Posições"}
            </button>
          ))}
        </div>
      </div>

      {escopo === "recebimento" && (
        <div className="note">Material em recebimento (REC e P07) ainda não pode ser contado para fornecimento — por isso é mostrado separado do estoque.</div>
      )}
      {escopo === "fora" && (
        <div className="note">Depósitos fora do controle (AQB, CLI, EST, EXP, INV, P08, P33). Exibidos apenas para consulta; não entram nos totais do estoque.</div>
      )}

      <section className="card filters" aria-label="Filtros">
        <label className="search" style={{ flex: "1 1 320px" }}>
          Buscar por nome, PI, endereço ou lote
          <input
            type="search"
            placeholder='Ex.: "calça branca", 190007973, 07-40-02'
            value={f.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </label>
        <label>
          Área
          <select value={f.area} onChange={(e) => set("area", e.target.value)}>
            <option value="">Todas</option>
            {opcoes.areas.map((a) => (
              <option key={a} value={a}>{a}{NOME_AREA[a] ? ` · ${NOME_AREA[a]}` : ""}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={f.status} onChange={(e) => set("status", e.target.value as Filtros["status"])}>
            <option value="todos">Livre e bloqueado</option>
            <option value="livre">Somente livre</option>
            <option value="bloqueado">Somente bloqueado</option>
          </select>
        </label>
        <label>
          Motivo do bloqueio
          <select value={f.motivo} onChange={(e) => set("motivo", e.target.value)}>
            <option value="">Todos</option>
            {opcoes.motivos.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Validade
          <select value={f.validade} onChange={(e) => set("validade", e.target.value as Validade)}>
            <option value="todas">Todas</option>
            <option value="vencido">Vencidos</option>
            <option value="90">Vencem em até 90 dias</option>
            <option value="sem">Sem validade</option>
          </select>
        </label>
        <div style={{ flexBasis: "100%" }} className="chips" role="group" aria-label="Depósitos">
          <span className="muted small" style={{ alignSelf: "center" }}>Depósito:</span>
          {opcoes.deps.map((d) => (
            <button
              key={d}
              className="chip"
              title={NOME_DEPOSITO[d]}
              aria-pressed={f.deps.includes(d)}
              onClick={() => set("deps", f.deps.includes(d) ? f.deps.filter((x) => x !== d) : [...f.deps, d])}
            >
              {d}
            </button>
          ))}
          {filtrosAtivos && (
            <button className="btn small" onClick={() => setF(FILTROS_INICIAIS)}>Limpar filtros</button>
          )}
        </div>
      </section>

      {aba === "resumo" && <Resumo linhas={filtradas} dados={dados} hoje={hoje} escopo={escopo} />}
      {aba === "produtos" && <Produtos linhas={filtradas} dados={dados} />}
      {aba === "posicoes" && <Posicoes linhas={filtradas} dados={dados} />}
    </div>
  );
}

/* ---------------------------------------------------------------- Resumo */

function Kpi({ v, l, tone }: { v: string; l: string; tone?: "ok" | "bad" | "warn" }) {
  return (
    <div className={`card kpi ${tone ?? ""}`}>
      <div className="v">{v}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function Resumo({ linhas, dados, hoje, escopo }: { linhas: Linha[]; dados: Dados; hoje: Date; escopo: Escopo }) {
  const r = useMemo(() => {
    const tot = novoAgg();
    const porDep: Record<string, Agregado> = {};
    const porPi: Record<string, Agregado> = {};
    let vencidoQtd = 0, vencidoPis = new Set<string>(), venc90Qtd = 0, venc90Pis = new Set<string>();
    for (const l of linhas) {
      somar(tot, l);
      somar((porDep[l.dep] ??= novoAgg()), l);
      somar((porPi[l.pi] ??= novoAgg()), l);
      if (l.val && l.disp > 0) {
        const d = diasAte(l.val, hoje);
        if (d < 0) { vencidoQtd += l.disp; vencidoPis.add(l.pi); }
        else if (d <= 90) { venc90Qtd += l.disp; venc90Pis.add(l.pi); }
      }
    }
    const comBloqueio = Object.entries(porPi)
      .filter(([, a]) => a.bloq > 0)
      .sort((a, b) => b[1].bloq - a[1].bloq);
    const pisComSaldoLivre = Object.values(porPi).filter((a) => a.livre > 0).length;
    return { tot, porDep, comBloqueio, vencidoQtd, vencidoPis: vencidoPis.size, venc90Qtd, venc90Pis: venc90Pis.size, pisComSaldoLivre, nPis: Object.keys(porPi).length };
  }, [linhas, hoje]);

  const maxDep = Math.max(1, ...Object.values(r.porDep).map((a) => a.livre + a.bloq));
  const motivos = Object.entries(r.tot.motivos).sort((a, b) => b[1] - a[1]);
  const p03 = escopo === "estoque" ? linhas.filter((l) => l.dep === "P03") : [];

  // totais de recebimento e fora do controle, independentes dos filtros
  const recebimento = useMemo(() => {
    const a = novoAgg();
    for (const l of dados.linhas) if (dados.escopos[l.dep] === "recebimento") somar(a, l);
    return a;
  }, [dados]);

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="grid g4">
        <Kpi v={fmtNum(r.tot.livre)} l="Unidades LIVRES (disponíveis de fato)" tone="ok" />
        <Kpi v={fmtNum(r.tot.bloq)} l="Unidades BLOQUEADAS" tone={r.tot.bloq ? "bad" : undefined} />
        <Kpi v={`${fmtNum(r.pisComSaldoLivre)} / ${fmtNum(r.nPis)}`} l="PIs com saldo livre / PIs com registro" />
        <Kpi v={fmtNum(r.tot.posicoes)} l="Posições (paletes/IDs)" />
        <Kpi v={fmtNum(r.vencidoQtd)} l={`Unidades vencidas (${fmtNum(r.vencidoPis)} PIs)`} tone={r.vencidoQtd ? "bad" : undefined} />
        <Kpi v={fmtNum(r.venc90Qtd)} l={`Vencem em até 90 dias (${fmtNum(r.venc90Pis)} PIs)`} tone={r.venc90Qtd ? "warn" : undefined} />
        {escopo === "estoque" && (
          <Kpi v={fmtNum(recebimento.livre + recebimento.bloq)} l={`Em recebimento, fora da conta acima (${fmtNum(recebimento.livre)} livres)`} tone="warn" />
        )}
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Por depósito</h2>
          {Object.entries(r.porDep)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([d, a]) => (
              <div className="hbar" key={d} title={NOME_DEPOSITO[d]}>
                <strong>{d}</strong>
                <div className="track" aria-hidden>
                  <i className="a" style={{ width: `${(a.livre / maxDep) * 100}%` }} />
                  <i className="b" style={{ width: `${(a.bloq / maxDep) * 100}%` }} />
                </div>
                <span className="val">{fmtNum(a.livre)}{a.bloq ? <span className="muted"> + {fmtNum(a.bloq)} bloq.</span> : null}</span>
              </div>
            ))}
          <p className="muted small">Verde = livre · Vermelho = bloqueado. Passe o mouse sobre o depósito para ver a descrição.</p>
        </div>

        <div className="card">
          <h2>Bloqueios por motivo</h2>
          {motivos.length === 0 && <p className="muted">Nada bloqueado neste filtro.</p>}
          <table>
            <tbody>
              {motivos.map(([m, q]) => (
                <tr key={m}>
                  <td><span className="tag bad">{m}</span></td>
                  <td className="n">{fmtNum(q)}</td>
                  <td className="n muted">{r.tot.bloq ? Math.round((q / r.tot.bloq) * 100) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>PIs com bloqueio — livre x bloqueado</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Mostra o quanto de cada PI realmente pode ser usado e o quanto está preso, e por quê.
        </p>
        <div className="tablewrap" style={{ maxHeight: 420 }}>
          <table>
            <thead>
              <tr><th>PI</th><th>Descrição</th><th className="n">Livre</th><th className="n">Bloqueado</th><th>Motivos</th></tr>
            </thead>
            <tbody>
              {r.comBloqueio.slice(0, 100).map(([pi, a]) => (
                <tr key={pi}>
                  <td>{pi}</td>
                  <td className="wrapc">{dados.produtos[pi]?.desc}</td>
                  <td className="n">{fmtNum(a.livre)}</td>
                  <td className="n"><strong>{fmtNum(a.bloq)}</strong></td>
                  <td className="wrapc">
                    {Object.entries(a.motivos).map(([m, q]) => (
                      <span key={m} className="tag bad" style={{ marginRight: 4 }}>{m}: {fmtNum(q)}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.comBloqueio.length > 100 && <p className="muted small">Mostrando os 100 maiores bloqueios de {r.comBloqueio.length} PIs. Use os filtros para refinar.</p>}
      </div>

      {p03.length > 0 && (
        <div className="card">
          <h2>Atenção · Paiol 03 (volante) — material não deve permanecer</h2>
          <p className="small">
            {fmtNum(new Set(p03.map((l) => l.pi)).size)} PIs / {fmtNum(p03.reduce((s, l) => s + l.disp, 0))} unidades no P03. Veja em Posições filtrando o depósito P03.
          </p>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Produtos */

function StatusTag({ l }: { l: Linha }) {
  return l.livre ? <span className="tag ok">LIVRE</span> : <span className="tag bad">{l.motivo || "BLOQUEADO"}</span>;
}

function ValidadeTag({ val }: { val: string }) {
  const [hoje] = useState(() => new Date());
  if (!val) return <span className="muted">—</span>;
  const d = diasAte(val, hoje);
  return (
    <span>
      {fmtData(val)} {d < 0 ? <span className="tag bad">vencido</span> : d <= 90 ? <span className="tag warn">{d}d</span> : null}
    </span>
  );
}

function TabelaPosicoes({ linhas }: { linhas: Linha[] }) {
  const ord = [...linhas].sort((a, b) => a.dep.localeCompare(b.dep) || a.end.localeCompare(b.end, "pt-BR", { numeric: true }));
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr><th>Dep.</th><th>Área</th><th>Endereço</th><th className="n">Disponível</th><th>Status</th><th>Lote</th><th>Validade</th><th>ID</th></tr>
        </thead>
        <tbody>
          {ord.map((l) => (
            <tr key={l.id + l.end + l.dep}>
              <td>{l.dep}</td><td>{l.area}</td><td>{l.end}</td>
              <td className="n">{fmtNum(l.disp)}</td>
              <td><StatusTag l={l} /></td>
              <td>{l.lote || "—"}</td>
              <td><ValidadeTag val={l.val} /></td>
              <td className="muted">{l.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ondeEsta(a: Agregado) {
  const com = Object.entries(a.deps).filter(([, q]) => q > 0);
  return (com.length ? com : Object.entries(a.deps))
    .sort((x, y) => y[1] - x[1])
    .map(([d, q]) => `${d}: ${fmtNum(q)}`)
    .join(" · ");
}

const POR_PAGINA = 100;

function Paginador({ total, pag, setPag }: { total: number; pag: number; setPag: (n: number) => void }) {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  return (
    <div className="pager">
      <span className="muted small">
        {total === 0 ? "Nenhum resultado" : `${fmtNum(pag * POR_PAGINA + 1)}–${fmtNum(Math.min(total, (pag + 1) * POR_PAGINA))} de ${fmtNum(total)}`}
      </span>
      <span style={{ display: "flex", gap: 6 }}>
        <button disabled={pag === 0} onClick={() => setPag(pag - 1)}>← Anterior</button>
        <button disabled={pag >= paginas - 1} onClick={() => setPag(pag + 1)}>Próxima →</button>
      </span>
    </div>
  );
}

interface ItemPi { pi: string; desc: string; variante: string; agg: Agregado; linhas: Linha[] }
interface ItemFamilia { familia: string; agg: Agregado; itens: ItemPi[] }

function Produtos({ linhas, dados }: { linhas: Linha[]; dados: Dados }) {
  const [agrupar, setAgrupar] = useState(true);
  const [aberto, setAberto] = useState<Record<string, boolean>>({});
  const [pag, setPag] = useState(0);

  const { familias, itens } = useMemo(() => {
    const porPi = new Map<string, ItemPi>();
    for (const l of linhas) {
      let it = porPi.get(l.pi);
      if (!it) {
        const p = dados.produtos[l.pi];
        it = { pi: l.pi, desc: p?.desc ?? l.pi, variante: p?.variante ?? "", agg: novoAgg(), linhas: [] };
        porPi.set(l.pi, it);
      }
      somar(it.agg, l);
      it.linhas.push(l);
    }
    const itens = [...porPi.values()].sort((a, b) => a.desc.localeCompare(b.desc, "pt-BR", { numeric: true }));
    const porFam = new Map<string, ItemFamilia>();
    for (const it of itens) {
      const nome = dados.produtos[it.pi]?.familia ?? it.desc;
      let fam = porFam.get(nome);
      if (!fam) {
        fam = { familia: nome, agg: novoAgg(), itens: [] };
        porFam.set(nome, fam);
      }
      fam.itens.push(it);
      fam.agg.livre += it.agg.livre;
      fam.agg.bloq += it.agg.bloq;
      fam.agg.posicoes += it.agg.posicoes;
      for (const [d, q] of Object.entries(it.agg.deps)) fam.agg.deps[d] = (fam.agg.deps[d] || 0) + q;
      for (const [m, q] of Object.entries(it.agg.motivos)) fam.agg.motivos[m] = (fam.agg.motivos[m] || 0) + q;
    }
    const familias = [...porFam.values()];
    for (const fam of familias) fam.itens.sort((a, b) => cmpVariante(a.variante, b.variante) || a.desc.localeCompare(b.desc));
    familias.sort((a, b) => a.familia.localeCompare(b.familia, "pt-BR", { numeric: true }));
    return { familias, itens };
  }, [linhas, dados]);

  useEffect(() => setPag(0), [linhas, agrupar]);
  const alternar = (k: string) => setAberto((o) => ({ ...o, [k]: !o[k] }));
  const lista = agrupar ? familias : itens;
  const pagina = lista.slice(pag * POR_PAGINA, (pag + 1) * POR_PAGINA);

  return (
    <div className="card">
      <div className="bar" style={{ justifyContent: "space-between" }}>
        <div className="seg" role="group" aria-label="Agrupamento">
          <button aria-pressed={agrupar} onClick={() => setAgrupar(true)}>Agrupar por família (grade)</button>
          <button aria-pressed={!agrupar} onClick={() => setAgrupar(false)}>Um PI por linha</button>
        </div>
        <span className="muted small">
          {fmtNum(itens.length)} PIs · {fmtNum(familias.length)} famílias · clique numa linha para ver {agrupar ? "tamanhos e posições" : "posições"}
        </span>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>{agrupar ? "Família" : "PI"}</th>
              {!agrupar && <th>Descrição</th>}
              <th className="n">Livre</th><th className="n">Bloqueado</th><th>Onde está (livre + bloq.)</th>
            </tr>
          </thead>
          <tbody>
            {agrupar
              ? (pagina as ItemFamilia[]).map((fam) => {
                  const k = "f:" + fam.familia;
                  return (
                    <FamiliaLinha key={k} fam={fam} aberto={!!aberto[k]} onToggle={() => alternar(k)} abertoPi={aberto} onTogglePi={alternar} />
                  );
                })
              : (pagina as ItemPi[]).map((it) => (
                  <PiLinha key={it.pi} it={it} mostrarPi aberto={!!aberto["p:" + it.pi]} onToggle={() => alternar("p:" + it.pi)} colunas={5} />
                ))}
          </tbody>
        </table>
      </div>
      <Paginador total={lista.length} pag={pag} setPag={setPag} />
    </div>
  );
}

function BadgeBloq({ agg }: { agg: Agregado }) {
  return agg.bloq > 0 ? <strong style={{ color: "var(--bad)" }}>{fmtNum(agg.bloq)}</strong> : <span className="muted">0</span>;
}

function PiLinha({ it, aberto, onToggle, mostrarPi, colunas }: { it: ItemPi; aberto: boolean; onToggle: () => void; mostrarPi: boolean; colunas: number }) {
  return (
    <>
      <tr className="click" onClick={onToggle}>
        <td>{aberto ? "▾" : "▸"} {it.pi}</td>
        {mostrarPi ? <td className="wrapc">{it.desc}</td> : null}
        <td className="n">{fmtNum(it.agg.livre)}</td>
        <td className="n"><BadgeBloq agg={it.agg} /></td>
        <td className="wrapc small">{ondeEsta(it.agg)}</td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={colunas}>
            {Object.keys(it.agg.motivos).length > 0 && (
              <p style={{ margin: "4px 0" }}>
                Bloqueios: {Object.entries(it.agg.motivos).map(([m, q]) => (
                  <span key={m} className="tag bad" style={{ marginRight: 4 }}>{m}: {fmtNum(q)}</span>
                ))}
              </p>
            )}
            <TabelaPosicoes linhas={it.linhas} />
          </td>
        </tr>
      )}
    </>
  );
}

function FamiliaLinha({ fam, aberto, onToggle, abertoPi, onTogglePi }: {
  fam: ItemFamilia; aberto: boolean; onToggle: () => void; abertoPi: Record<string, boolean>; onTogglePi: (k: string) => void;
}) {
  const unico = fam.itens.length === 1;
  return (
    <>
      <tr className="click" onClick={onToggle}>
        <td className="wrapc">
          {aberto ? "▾" : "▸"} {fam.familia} <span className="muted small">({fam.itens.length} {fam.itens.length === 1 ? "PI" : "PIs"})</span>
        </td>
        <td className="n">{fmtNum(fam.agg.livre)}</td>
        <td className="n"><BadgeBloq agg={fam.agg} /></td>
        <td className="wrapc small">{ondeEsta(fam.agg)}</td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={4}>
            {!unico && (
              <div className="grade" aria-label="Grade de tamanhos (livre)">
                {fam.itens.map((it) => (
                  <span key={it.pi} title={`${it.desc} · PI ${it.pi}`}>
                    <b>{it.variante || "—"}</b>: {fmtNum(it.agg.livre)}
                    {it.agg.bloq > 0 && <span style={{ color: "var(--bad)" }}> (+{fmtNum(it.agg.bloq)} bloq.)</span>}
                  </span>
                ))}
              </div>
            )}
            <table>
              <thead>
                <tr><th>PI</th><th>Tamanho / variação</th><th className="n">Livre</th><th className="n">Bloqueado</th><th>Onde está</th></tr>
              </thead>
              <tbody>
                {fam.itens.map((it) => {
                  const k = "p:" + it.pi;
                  return (
                    <PiVariante key={it.pi} it={it} aberto={!!abertoPi[k]} onToggle={() => onTogglePi(k)} />
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

function PiVariante({ it, aberto, onToggle }: { it: ItemPi; aberto: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="click" onClick={onToggle}>
        <td>{aberto ? "▾" : "▸"} {it.pi}</td>
        <td>{it.variante || <span className="muted" title={it.desc}>{it.desc}</span>}</td>
        <td className="n">{fmtNum(it.agg.livre)}</td>
        <td className="n"><BadgeBloq agg={it.agg} /></td>
        <td className="wrapc small">{ondeEsta(it.agg)}</td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={5}>
            {Object.keys(it.agg.motivos).length > 0 && (
              <p style={{ margin: "4px 0" }}>
                Bloqueios: {Object.entries(it.agg.motivos).map(([m, q]) => (
                  <span key={m} className="tag bad" style={{ marginRight: 4 }}>{m}: {fmtNum(q)}</span>
                ))}
              </p>
            )}
            <TabelaPosicoes linhas={it.linhas} />
          </td>
        </tr>
      )}
    </>
  );
}

/* -------------------------------------------------------------- Posições */

type ColSort = "dep" | "end" | "pi" | "desc" | "disp" | "val";

function Posicoes({ linhas, dados }: { linhas: Linha[]; dados: Dados }) {
  const [sort, setSort] = useState<{ col: ColSort; asc: boolean }>({ col: "dep", asc: true });
  const [pag, setPag] = useState(0);
  useEffect(() => setPag(0), [linhas, sort]);

  const ordenadas = useMemo(() => {
    const v = (l: Linha): string | number => {
      switch (sort.col) {
        case "dep": return l.dep;
        case "end": return l.end;
        case "pi": return l.pi;
        case "desc": return dados.produtos[l.pi]?.desc ?? "";
        case "disp": return l.disp;
        case "val": return l.val || "9999";
      }
    };
    const arr = [...linhas].sort((a, b) => {
      const x = v(a), y = v(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "pt-BR", { numeric: true });
      return (sort.asc ? c : -c) || a.end.localeCompare(b.end, "pt-BR", { numeric: true });
    });
    return arr;
  }, [linhas, sort, dados]);

  const pagina = ordenadas.slice(pag * POR_PAGINA, (pag + 1) * POR_PAGINA);
  const th = (col: ColSort, nome: string, n = false) => (
    <th className={`sortable ${n ? "n" : ""}`} onClick={() => setSort((s) => ({ col, asc: s.col === col ? !s.asc : true }))}>
      {nome} {sort.col === col ? (sort.asc ? "▲" : "▼") : ""}
    </th>
  );

  function exportar() {
    const cab = ["Depósito", "Área", "Endereço", "PI", "Descrição", "Disponível", "Total", "Status", "Motivo", "Fornecedor", "Lote", "Fabricação", "Validade", "ID_QUANT"];
    const corpo = ordenadas.map((l) => [l.dep, l.area, l.end, l.pi, dados.produtos[l.pi]?.desc ?? "", String(l.disp).replace(".", ","), String(l.total).replace(".", ","), l.livre ? "LIVRE" : "BLOQUEADO", l.motivo, l.forn, l.lote, fmtData(l.fab), fmtData(l.val), l.id]);
    const blob = new Blob(["﻿" + csv([cab, ...corpo])], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "posicoes-estoque.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="card">
      <div className="bar" style={{ justifyContent: "space-between" }}>
        <span className="muted small">{fmtNum(linhas.length)} posições · {fmtNum(linhas.reduce((s, l) => s + l.disp, 0))} unidades (livres + bloqueadas)</span>
        <button className="btn" onClick={exportar} disabled={!linhas.length}>Exportar CSV</button>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {th("dep", "Dep.")}<th>Área</th>{th("end", "Endereço")}{th("pi", "PI")}{th("desc", "Descrição")}
              {th("disp", "Disponível", true)}<th>Status</th><th>Lote</th>{th("val", "Validade")}<th>ID</th>
            </tr>
          </thead>
          <tbody>
            {pagina.map((l) => (
              <tr key={l.id + l.dep + l.end}>
                <td title={NOME_DEPOSITO[l.dep]}>{l.dep}</td>
                <td title={NOME_AREA[l.area]}>{l.area}</td>
                <td>{l.end}</td>
                <td>{l.pi}</td>
                <td className="wrapc">{dados.produtos[l.pi]?.desc}</td>
                <td className="n">{fmtNum(l.disp)}</td>
                <td><StatusTag l={l} /></td>
                <td>{l.lote || "—"}</td>
                <td><ValidadeTag val={l.val} /></td>
                <td className="muted">{l.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginador total={ordenadas.length} pag={pag} setPag={setPag} />
    </div>
  );
}
