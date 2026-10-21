"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { NOME_DEPOSITO } from "@/lib/config";
import type { Missao, Parametros } from "@/lib/missoes";
import { CALCADOS_PRIMEIRA_PALAVRA } from "@/lib/config";
import type { Dados } from "@/lib/types";
import type { RmDados } from "@/lib/rm";
import { COR_OUTROS, PALETA, coresDosGrupos, grupoDaFamilia, tintaSobre, type Classificacao } from "@/lib/grupos";
import { FAIXAS_COBERTURA, NOME_CLASSE, calcularGiro, diaParaData, faixaCobertura, type ClasseGiro, type FaixaCobertura, type Giro, type GiroPi } from "@/lib/giro";
import { csv, fmtNum } from "@/lib/util";
import { Carga } from "./Missoes";
import { ClassificacaoGrupos } from "./ClassificacaoGrupos";

/* --------------------------------------------------------------------------- modelo */

interface Item { pi: string; qtd: number; bloq: number }
interface Slot { key: string; end: string; area: string; rua: number; col: number; nivel: number; lado: string; itens: Item[]; vazia: boolean }
type Fluxo = "recomp" | "devolucao" | "frfr" | "descer" | "sc";

const RE_END = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(AA|BB)$/;
const ABERTA = (m: Missao) => m.status === "pendente" || m.status === "em_execucao" || m.status === "divergente" || m.status === "feita";
const chave = (dep: string, end: string) => `${dep}|${end}`;

const FLUXOS: Record<Fluxo, { nome: string; cor: string }> = {
  recomp: { nome: "Recompletamento (SC → FR)", cor: "#2563eb" },
  frfr: { nome: "Ajuste no FR (FR → FR)", cor: "#ea580c" },
  devolucao: { nome: "Devolução (FR → SC)", cor: "#9333ea" },
  descer: { nome: "Descer palete (alto → altura 02)", cor: "#0891b2" },
  sc: { nome: "Desmisturar / consolidar SC", cor: "#0d9488" },
};

function tipoFluxo(m: Missao, frLocs: Set<string>): Fluxo {
  if (m.tipo === "recompletamento") return "recomp";
  if (m.sub === "descer") return "descer";
  if (m.sub) return "sc";
  return frLocs.has(chave(m.para.dep, m.para.end)) || /^(Juntar|Faltam LOCs|Levar para)/.test(m.motivo) ? "frfr" : "devolucao";
}

function montarSlots(d: Dados) {
  const porDep = new Map<string, Map<string, Slot>>();
  const slot = (dep: string, end: string, area: string) => {
    const m = RE_END.exec(end);
    if (!m) return null;
    const mp = porDep.get(dep) ?? porDep.set(dep, new Map()).get(dep)!;
    let s = mp.get(end);
    if (!s) mp.set(end, (s = { key: chave(dep, end), end, area, rua: +m[1], col: +m[2], nivel: +m[3], lado: m[4], itens: [], vazia: false }));
    if (!s.area) s.area = area;
    return s;
  };
  for (const l of d.linhas) {
    if (d.escopos[l.dep] !== "estoque" || !(l.total > 0 || l.disp > 0)) continue;
    const s = slot(l.dep, l.end, l.area);
    if (!s) continue;
    let it = s.itens.find((x) => x.pi === l.pi);
    if (!it) s.itens.push((it = { pi: l.pi, qtd: 0, bloq: 0 }));
    it.qtd += l.total || l.disp;
    if (!l.livre) it.bloq += l.total || l.disp;
  }
  for (const v of d.vazias ?? []) {
    const s = slot(v.dep, v.end.toUpperCase(), v.area);
    if (s && s.itens.length === 0) s.vazia = true;
  }
  return porDep;
}

/* --------------------------------------------------------------------------- tela */

export function MapaPaiol({ estoque }: { estoque: Dados | null }) {
  if (!estoque) return <p className="muted">Carregando a planilha de estoque…</p>;
  return <Carga>{(d) => <MapaComAbas estoque={estoque} missoes={d.missoes} params={d.params} />}</Carga>;
}

type Visao = "situacao" | "grupos" | "giro" | "cobertura";

const COR_CLASSE: Record<ClasseGiro, string> = { A: "#184f95", B: "#3987e5", C: "#86b6ef", S: "#eb6834" };
const COR_FAIXA: Record<FaixaCobertura, string> = { falta: "#d03b3b", ok: "#d4d3cf", alta: "#6da7ec", excesso: "#1c5cab", parado: "#eda100" };
const COR_APAGADA = "#eef1f5";
const COR_FAMILIA_OUTRAS = "#8a8f98";

/** Classificação de grupos (JSON compartilhado) — carregada uma vez e atualizada ao salvar. */
function useClassificacao() {
  const [c, setC] = useState<Classificacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/grupos", { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.erro || "Falha ao carregar a classificação"); setC(j); })
      .catch((e) => setErro(e instanceof Error ? e.message : "Falha ao carregar a classificação"));
  }, []);
  return { classif: c, setClassif: setC, erro };
}

/** Planilha de pedidos: só baixa quando uma visão que precisa dela é aberta. */
function useRm(ativo: boolean) {
  const [rm, setRm] = useState<RmDados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const pedido = useRef(false);
  useEffect(() => {
    if (!ativo || pedido.current) return;
    pedido.current = true;
    fetch("/api/rm", { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.erro || "Falha ao carregar a planilha de pedidos"); setRm(j); })
      .catch((e) => { pedido.current = false; setErro(e instanceof Error ? e.message : "Falha ao carregar a planilha de pedidos"); });
  }, [ativo]);
  return { rm, erro };
}

function MapaComAbas({ estoque, missoes, params }: { estoque: Dados; missoes: Missao[]; params: Parametros }) {
  const [aba, setAba] = useState<"mapa" | "classificacao">("mapa");
  const { classif, setClassif, erro } = useClassificacao();
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="seg" role="group" aria-label="Mapa ou classificação" style={{ justifySelf: "start" }}>
        <button aria-pressed={aba === "mapa"} onClick={() => setAba("mapa")}>Mapa</button>
        <button aria-pressed={aba === "classificacao"} onClick={() => setAba("classificacao")}>Classificação de grupos e famílias</button>
      </div>
      {erro && <div className="note">{erro}. O mapa por grupos usa a classificação padrão (1ª palavra da descrição).</div>}
      <div hidden={aba !== "mapa"}>
        <Mapa estoque={estoque} missoes={missoes} params={params} classif={classif} />
      </div>
      {aba === "classificacao" && <ClassificacaoGrupos estoque={estoque} classif={classif} onSalvo={setClassif} />}
    </div>
  );
}

// geometria (unidades do SVG; o zoom só escala)
const CW = 40; // largura de uma posição (coluna): AA + BB
const LH = 12; // altura de um nível (cabe o número de caixas dentro)
const CORREDOR = 30;
const MARGEM = 54;

function Mapa({ estoque, missoes, params, classif }: { estoque: Dados; missoes: Missao[]; params: Parametros; classif: Classificacao | null }) {
  const porDep = useMemo(() => montarSlots(estoque), [estoque]);
  const [visao, setVisaoBruta] = useState<Visao>("situacao");
  const [setas, setSetas] = useState(true);
  // nas visões de grupo e giro as setas das missões escondem as cores: começam desligadas
  const setVisao = (v: Visao) => { setVisaoBruta(v); setSetas(v === "situacao"); };
  const [grupoFoco, setGrupoFoco] = useState<string | null>(null);
  const [periodo, setPeriodo] = useState(365);
  const precisaRm = visao === "giro" || visao === "cobertura";
  const { rm, erro: erroRm } = useRm(precisaRm);
  const giro = useMemo(() => (rm ? calcularGiro(rm, estoque, periodo || null) : null), [rm, estoque, periodo]);
  const familiaDe = (pi: string) => estoque.produtos[pi]?.familia ?? pi;
  const grupoDe = (pi: string) => grupoDaFamilia(classif, familiaDe(pi));
  const coresGrupo = useMemo(() => coresDosGrupos(estoque, classif), [estoque, classif]);
  // cores das famílias do grupo em foco: as 8 que mais ocupam LOCs no estoque inteiro (estáveis ao trocar de paiol)
  const coresFamilia = useMemo(() => {
    const m = new Map<string, string>();
    if (!grupoFoco) return m;
    const locs = new Map<string, Set<string>>();
    for (const l of estoque.linhas) {
      if (estoque.escopos[l.dep] !== "estoque" || !(l.total > 0 || l.disp > 0)) continue;
      const f = estoque.produtos[l.pi]?.familia ?? l.pi;
      if (grupoDaFamilia(classif, f) !== grupoFoco) continue;
      (locs.get(f) ?? locs.set(f, new Set()).get(f)!).add(`${l.dep}|${l.end}`);
    }
    [...locs.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).forEach(([f], i) => m.set(f, PALETA[i] ?? COR_FAMILIA_OUTRAS));
    return m;
  }, [estoque, classif, grupoFoco]);
  const deps = useMemo(() => [...porDep.keys()].sort(), [porDep]);
  const [dep, setDep] = useState(deps.includes("P05") ? "P05" : deps[0] ?? "");
  const [rua, setRua] = useState<number | "">("");
  const [zoomManual, setZoomManual] = useState<number | null>(null); // null = ajusta à largura da tela
  const caixa = useRef<HTMLDivElement>(null);
  const [larguraTela, setLarguraTela] = useState(900);
  useEffect(() => {
    const el = caixa.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLarguraTela(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [busca, setBusca] = useState("");
  const [sel, setSel] = useState<{ rua: number; col: number } | null>(null);
  const [mostrar, setMostrar] = useState<Record<Fluxo, boolean>>({ recomp: true, frfr: true, devolucao: true, descer: true, sc: true });
  const [onda, setOnda] = useState<number | "">("");
  const [soDaSelecao, setSoDaSelecao] = useState(false);

  const slots = porDep.get(dep) ?? new Map<string, Slot>();
  const ruas = useMemo(() => [...new Set([...slots.values()].map((s) => s.rua))].sort((a, b) => a - b), [slots]);
  const frLocs = useMemo(() => new Set([...slots.values()].filter((s) => s.area === "FR").map((s) => s.key)), [slots]);
  const cxpDe = (pi: string) => estoque.produtos[pi]?.cxp;
  const desc = (pi: string) => estoque.produtos[pi]?.desc ?? "";

  const abertas = useMemo(() => missoes.filter((m) => ABERTA(m) && (m.de.dep === dep || m.para.dep === dep)), [missoes, dep]);
  const ondas = useMemo(() => [...new Set(abertas.map((m) => m.onda))].sort((a, b) => a - b), [abertas]);
  const visiveis = abertas.filter((m) => mostrar[tipoFluxo(m, frLocs)] && (onda === "" || m.onda === onda));

  // geometria de cada rua (blocos empilhados)
  const layout = useMemo(() => {
    const blocos: { rua: number; y: number; nivTop: number; nivBot: number; pos: number; h: number }[] = [];
    let y = 8, largura = 0;
    for (const r of ruas) {
      if (rua !== "" && r !== rua) continue;
      const ss = [...slots.values()].filter((s) => s.rua === r);
      const maxCol = Math.max(...ss.map((s) => s.col));
      const nivTop = Math.min(8, Math.max(1, ...ss.filter((s) => s.col % 2 === 1).map((s) => s.nivel)));
      const nivBot = Math.min(8, Math.max(1, ...ss.filter((s) => s.col % 2 === 0).map((s) => s.nivel)));
      const pos = Math.ceil(maxCol / 2);
      const h = 16 + nivTop * LH + CORREDOR + nivBot * LH + 14;
      blocos.push({ rua: r, y, nivTop, nivBot, pos, h });
      y += h;
      largura = Math.max(largura, MARGEM + pos * CW + 12);
    }
    return { blocos, altura: y + 8, largura: Math.max(largura, 400) };
  }, [ruas, rua, slots]);
  const bloco = (r: number) => layout.blocos.find((b) => b.rua === r);
  const zoom = zoomManual ?? Math.max(0.6, Math.min(3.5, (larguraTela - 24) / layout.largura));

  /** Retângulo de um endereço no desenho (null se a rua não está visível). */
  const geo = (s: { rua: number; col: number; nivel: number; lado: string }) => {
    const b = bloco(s.rua);
    if (!b) return null;
    const p = Math.ceil(s.col / 2);
    const x = MARGEM + (p - 1) * CW + (s.lado === "BB" ? CW / 2 : 0) + 1;
    const w = CW / 2 - 2;
    const yTopo = b.y + 16; // começo da fileira ímpar
    const yCorredor = yTopo + b.nivTop * LH;
    const nv = Math.min(s.nivel, 8);
    const y = s.col % 2 === 1 ? yCorredor - nv * LH : yCorredor + CORREDOR + (nv - 1) * LH;
    return { x, y, w, h: LH - 1 };
  };
  const geoEnd = (dp: string, end: string) => {
    if (dp !== dep) return null;
    const m = RE_END.exec(end);
    return m ? geo({ rua: +m[1], col: +m[2], nivel: +m[3], lado: m[4] }) : null;
  };

  const termo = busca.trim().toUpperCase();
  const casaBusca = (s: Slot) => !!termo && s.itens.some((i) => i.pi.toUpperCase().includes(termo) || desc(i.pi).toUpperCase().includes(termo));
  const tocaSel = (m: Missao) => !!sel && [m.de, m.para].some((l) => { if (l.dep !== dep) return false; const x = RE_END.exec(l.end); return !!x && +x[1] === sel.rua && +x[2] === sel.col; });
  const naSelecao = (s: Slot) => !!sel && s.rua === sel.rua && s.col === sel.col;

  /** Situação de uma LOC FR com um PI só frente ao padrão: entre o mínimo e o máximo de caixas inteiras (calçado tem máximo próprio). */
  const padraoFr = (s: Slot): { ok: boolean | null; motivo: string } => {
    const it = s.itens[0];
    const c = cxpDe(it.pi);
    if (!c) return { ok: null, motivo: "sem caixa padrão (CXP): não dá para avaliar" };
    const calcado = CALCADOS_PRIMEIRA_PALAVRA.includes(desc(it.pi).trim().split(/\s+/)[0]?.toUpperCase());
    const max = params.caixasPorPi[it.pi] > 0 ? params.caixasPorPi[it.pi] : calcado ? params.maxCaixasCalcado : params.maxCaixas;
    const min = Math.min(max, calcado ? params.minCaixasCalcado : params.minCaixas);
    const cx = Math.floor(it.qtd / c + 1e-9);
    if (it.qtd < min * c - 1e-9) return { ok: false, motivo: `abaixo do mínimo: ${fmtNum(cx)} cx (mín. ${min})` };
    if (cx > max) return { ok: false, motivo: `acima do máximo: ${fmtNum(cx)} cx (máx. ${max}${calcado ? ", calçado" : ""})` };
    return { ok: true, motivo: `no padrão: ${fmtNum(cx)} cx (entre ${min} e ${max})` };
  };
  const cor = (s: Slot) => {
    if (s.vazia || s.itens.length === 0) return "#ffffff";
    if (s.itens.length > 1) return s.area === "SC" ? "#c026d3" : "#dc2626"; // mais de um PI: FR vermelho, SC magenta
    if (s.area === "FR") { const p = padraoFr(s).ok; return p === true ? "#16a34a" : p === false ? "#f97316" : "#d6b98c"; }
    if (s.area === "SC") return s.nivel <= 2 ? "#60a5fa" : "#1d4ed8";
    return "#94a3b8";
  };

  /** PI que mais ocupa a LOC (em caixas, ou unidades sem caixa padrão): é ele que dá a cor nas visões por PI. */
  const dominante = (s: Slot) => {
    let melhor = s.itens[0], v = -1;
    for (const i of s.itens) { const c = cxpDe(i.pi); const x = c ? i.qtd / c : i.qtd / 1e6; if (x > v) { v = x; melhor = i; } }
    return melhor;
  };
  const corVisao = (s: Slot) => {
    if (visao === "situacao" || s.vazia || s.itens.length === 0) return cor(s);
    const pi = dominante(s).pi;
    if (visao === "grupos") {
      const g = grupoDe(pi);
      if (grupoFoco) return g === grupoFoco ? coresFamilia.get(familiaDe(pi)) ?? COR_FAMILIA_OUTRAS : COR_APAGADA;
      return coresGrupo.get(g) ?? COR_OUTROS;
    }
    const gp = giro?.porPi.get(pi);
    if (!gp) return COR_APAGADA;
    return visao === "giro" ? COR_CLASSE[gp.classe] : COR_FAIXA[faixaCobertura(gp)];
  };
  const infoPi = (pi: string): string => {
    if (visao === "grupos") return `grupo ${grupoDe(pi)} · família ${familiaDe(pi)}`;
    if (visao === "giro" || visao === "cobertura") {
      const g = giro?.porPi.get(pi);
      if (!g) return "";
      return `${g.classe === "S" ? "sem saída no período" : `classe ${g.classe}`} · ${fmtNum(g.pedidos)} pedidos · ${fmtNum(g.unidades)} un no período · última saída ${diaParaData(g.ultimoDia)} · cobertura ${g.cobertura === null ? "—" : `${fmtNum(Math.round(g.cobertura))} dias`}`;
    }
    return "";
  };

  // números do paiol
  const resumo = useMemo(() => {
    const ss = [...slots.values()];
    const ocup = ss.filter((s) => s.itens.length > 0);
    return {
      total: ss.length,
      fr: ocup.filter((s) => s.area === "FR").length,
      frOk: ocup.filter((s) => s.area === "FR" && s.itens.length === 1 && padraoFr(s).ok === true).length,
      frFora: ocup.filter((s) => s.area === "FR" && (s.itens.length > 1 || padraoFr(s).ok === false)).length,
      sc: ocup.filter((s) => s.area === "SC").length,
      vazias: ss.filter((s) => s.vazia).length,
      mistasFr: ocup.filter((s) => s.itens.length > 1 && s.area !== "SC").length,
      mistasSc: ocup.filter((s) => s.itens.length > 1 && s.area === "SC").length,
      bloq: ocup.filter((s) => s.itens.some((i) => i.bloq > 0)).length,
    };
  }, [slots]);
  const porFluxo = useMemo(() => {
    const c: Record<Fluxo, number> = { recomp: 0, frfr: 0, devolucao: 0, descer: 0, sc: 0 };
    for (const m of abertas) c[tipoFluxo(m, frLocs)]++;
    return c;
  }, [abertas, frLocs]);

  const ruaVisivel = (l: { dep: string; end: string }) => l.dep === dep && (rua === "" || Number(l.end.split("-")[0]) === rua);
  const desenhadas = !setas ? [] : visiveis.filter((m) => (!soDaSelecao || tocaSel(m)) && (ruaVisivel(m.de) || ruaVisivel(m.para)));
  const LIMITE = 600;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="bar" style={{ marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
          <select value={dep} onChange={(e) => { setDep(e.target.value); setRua(""); setSel(null); }} aria-label="Paiol">
            {deps.map((d) => <option key={d} value={d}>{d} · {NOME_DEPOSITO[d] ?? d}</option>)}
          </select>
          <select value={rua} onChange={(e) => setRua(e.target.value === "" ? "" : +e.target.value)} aria-label="Rua">
            <option value="">Todas as ruas</option>
            {ruas.map((r) => <option key={r} value={r}>Rua {String(r).padStart(2, "0")}</option>)}
          </select>
          <input type="search" placeholder="Destacar PI ou descrição…" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ minWidth: 200 }} />
          <select value={onda} onChange={(e) => setOnda(e.target.value === "" ? "" : +e.target.value)} aria-label="Onda">
            <option value="">Todas as ondas</option>
            {ondas.map((o) => <option key={o} value={o}>Onda {o}</option>)}
          </select>
          <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={setas} onChange={(e) => setSetas(e.target.checked)} /> setas das missões
          </label>
          <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={soDaSelecao} onChange={(e) => setSoDaSelecao(e.target.checked)} /> fluxos só da posição selecionada
          </label>
          <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Zoom <input type="range" min={0.6} max={3.5} step={0.1} value={zoom} onChange={(e) => setZoomManual(+e.target.value)} />
            {zoomManual !== null && <button className="chip" onClick={() => setZoomManual(null)}>ajustar à tela</button>}
          </label>
        </div>
        <div className="bar" style={{ marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
          {(Object.keys(FLUXOS) as Fluxo[]).map((f) => (
            <button key={f} className="chip" aria-pressed={mostrar[f]} onClick={() => setMostrar({ ...mostrar, [f]: !mostrar[f] })} style={{ borderColor: FLUXOS[f].cor }}>
              <span style={{ display: "inline-block", width: 10, height: 3, background: FLUXOS[f].cor, marginRight: 6, verticalAlign: "middle" }} />
              {FLUXOS[f].nome} ({fmtNum(porFluxo[f])})
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: "2px 0" }}>
          {fmtNum(resumo.total)} posições conhecidas · {fmtNum(resumo.fr)} FR (<span style={{ color: "#16a34a" }}>{fmtNum(resumo.frOk)} no padrão</span>, <span style={{ color: "#ea580c" }}>{fmtNum(resumo.frFora)} fora</span>) e {fmtNum(resumo.sc)} SC ocupadas · {fmtNum(resumo.vazias)} vazias · com mais de um PI: <span style={{ color: "#dc2626" }}>{fmtNum(resumo.mistasFr)} FR</span> e <span style={{ color: "#c026d3" }}>{fmtNum(resumo.mistasSc)} SC</span> · {fmtNum(resumo.bloq)} com bloqueio · {fmtNum(abertas.length)} missões abertas no paiol
          {desenhadas.length > LIMITE && <> · <strong>mostrando {LIMITE} de {fmtNum(desenhadas.length)} fluxos</strong> (filtre por rua, onda ou tipo)</>}
        </p>
        <div className="bar" style={{ margin: "8px 0 0", gap: 8 }}>
          <span className="small muted">Visão:</span>
          <div className="seg" role="group" aria-label="Visão do mapa">
            <button aria-pressed={visao === "situacao"} onClick={() => setVisao("situacao")}>Situação das LOCs</button>
            <button aria-pressed={visao === "grupos"} onClick={() => setVisao("grupos")}>Grupos e famílias</button>
            <button aria-pressed={visao === "giro"} onClick={() => setVisao("giro")}>Giro (pedidos)</button>
            <button aria-pressed={visao === "cobertura"} onClick={() => setVisao("cobertura")}>Cobertura (estoque × saída)</button>
          </div>
          {precisaRm && (
            <select value={periodo} onChange={(e) => setPeriodo(+e.target.value)} aria-label="Período dos pedidos">
              <option value={90}>Pedidos dos últimos 90 dias</option>
              <option value={180}>Pedidos dos últimos 180 dias</option>
              <option value={365}>Pedidos dos últimos 12 meses</option>
              <option value={0}>Todo o histórico de pedidos</option>
            </select>
          )}
        </div>
        {visao === "situacao" && <Legenda />}
        {visao === "grupos" && (
          <LegendaGrupos slots={slots} grupoDe={grupoDe} familiaDe={familiaDe} dominante={dominante} coresGrupo={coresGrupo} coresFamilia={coresFamilia} foco={grupoFoco} setFoco={setGrupoFoco} />
        )}
        {precisaRm && !giro && <p className="small muted" style={{ margin: "6px 0 0" }}>{erroRm ? `Não foi possível carregar a planilha de pedidos: ${erroRm}` : "Carregando a planilha de pedidos…"}</p>}
        {precisaRm && giro && <LegendaGiro visao={visao} giro={giro} slots={slots} dominante={dominante} />}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div ref={caixa} className="card" style={{ flex: "1 1 640px", minWidth: 0, overflow: "auto", maxHeight: "78vh", padding: 8 }}>
          <svg width={layout.largura * zoom} height={layout.altura * zoom} viewBox={`0 0 ${layout.largura} ${layout.altura}`} style={{ display: "block", fontFamily: "inherit" }}>
            <defs>
              {(Object.keys(FLUXOS) as Fluxo[]).map((f) => (
                <marker key={f} id={`seta-${f}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={FLUXOS[f].cor} />
                </marker>
              ))}
            </defs>
            {layout.blocos.map((b) => {
              const yTopo = b.y + 16, yCorr = yTopo + b.nivTop * LH;
              return (
                <g key={b.rua}>
                  <text x={4} y={b.y + 11} fontSize={10} fontWeight={700} fill="currentColor">Rua {String(b.rua).padStart(2, "0")}</text>
                  <text x={4} y={yTopo + b.nivTop * LH - 2} fontSize={7} fill="#64707f">ímpares</text>
                  <text x={4} y={yCorr + CORREDOR + 9} fontSize={7} fill="#64707f">pares</text>
                  <rect x={MARGEM} y={yCorr + 3} width={b.pos * CW} height={CORREDOR - 6} rx={3} fill="#eef1f5" />
                  {Array.from({ length: b.pos }, (_, i) => (
                    <g key={i}>
                      <text x={MARGEM + i * CW + CW / 2} y={yCorr + 12} fontSize={7} textAnchor="middle" fill="#64707f">{String(2 * i + 1).padStart(2, "0")}</text>
                      <text x={MARGEM + i * CW + CW / 2} y={yCorr + CORREDOR - 6} fontSize={7} textAnchor="middle" fill="#64707f">{String(2 * i + 2).padStart(2, "0")}</text>
                    </g>
                  ))}
                </g>
              );
            })}
            {[...slots.values()].map((s) => {
              const g = geo(s);
              if (!g) return null;
              const realce = casaBusca(s);
              const selec = naSelecao(s);
              const bloq = s.itens.some((i) => i.bloq > 0);
              const titulo = `${dep} ${s.end} · ${s.area || "?"}${s.vazia ? " · VAZIA" : ""}${s.area === "FR" && s.itens.length === 1 ? ` · ${padraoFr(s).motivo}` : s.area === "FR" && s.itens.length > 1 ? " · fora do padrão: mais de um PI" : ""}\n` + s.itens.map((i) => {
                const c = cxpDe(i.pi);
                return `${i.pi} ${desc(i.pi)}: ${fmtNum(i.qtd)} un${c ? ` (${fmtNum(Math.round((i.qtd / c) * 10) / 10)} cx)` : ""}${i.bloq ? ` · bloq. ${fmtNum(i.bloq)}` : ""}`;
              }).join("\n");
              // total de caixas da LOC (todos os PIs); "+" = sobra solta de menos de 1 caixa; "?" = PI sem caixa padrão
              let total = 0, semCxp = false;
              for (const i of s.itens) { const c = cxpDe(i.pi); if (c) total += i.qtd / c; else if (i.qtd > 0) semCxp = true; }
              const inteiras = Math.floor(total + 1e-9);
              const rotulo = s.itens.length === 0 ? "" : semCxp && total === 0 ? "?" : `${inteiras}${total - inteiras > 1e-6 ? "+" : ""}${semCxp ? "?" : ""}`;
              // na visão de situação a busca pinta de amarelo; nas outras, apaga o que não casa (a cor continua dizendo o grupo/giro)
              const situacao = visao === "situacao";
              const fundo = situacao && realce ? "#facc15" : corVisao(s);
              const apagado = !situacao && !!termo && !realce;
              const info = situacao ? "" : s.itens.map((i) => { const t = infoPi(i.pi); return t ? `\n${i.pi}: ${t}` : ""; }).join("");
              return (
                <g key={s.key} opacity={apagado ? 0.18 : 1}>
                <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={1}
                  fill={fundo} stroke={selec ? "#111" : bloq ? "#111" : s.vazia ? "#94a3b8" : "#cbd5e1"}
                  strokeWidth={selec ? 1.6 : bloq ? 1 : 0.6} strokeDasharray={s.vazia ? "2 1" : undefined}
                  style={{ cursor: "pointer" }} onClick={() => setSel({ rua: s.rua, col: s.col })}>
                  <title>{titulo + info}</title>
                </rect>
                {!situacao && s.itens.length > 1 && <path d={`M${g.x + g.w - 5},${g.y} L${g.x + g.w},${g.y} L${g.x + g.w},${g.y + 5} z`} fill="#0f172a" style={{ pointerEvents: "none" }} />}
                {rotulo && <text x={g.x + g.w / 2} y={g.y + g.h / 2 + 2.9} fontSize={8} fontWeight={700} textAnchor="middle" fill={fundo === COR_APAGADA ? "#a3acb9" : tintaSobre(fundo)} style={{ pointerEvents: "none" }}>{rotulo}</text>}
                </g>
              );
            })}
            {desenhadas.slice(0, LIMITE).map((m) => {
              const a = geoEnd(m.de.dep, m.de.end), z = geoEnd(m.para.dep, m.para.end);
              if (!a || !z) return null;
              const f = tipoFluxo(m, frLocs);
              const x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = z.x + z.w / 2, y2 = z.y + z.h / 2;
              const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
              const curva = Math.min(40, len * 0.25);
              const cx = (x1 + x2) / 2 - (dy / len) * curva, cy = (y1 + y2) / 2 + (dx / len) * curva;
              const forte = !!sel && tocaSel(m);
              return (
                <path key={m.id} d={`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`} fill="none" stroke={FLUXOS[f].cor}
                  strokeWidth={forte ? 2.2 : 1.1} opacity={sel && !forte ? 0.15 : forte ? 1 : 0.55} markerEnd={`url(#seta-${f})`}
                  strokeDasharray={m.onda >= 2 ? "4 2" : undefined}>
                  <title>{`${m.id} · onda ${m.onda} · ${m.pi} ${fmtNum(m.qtd)} un · ${m.de.end} → ${m.para.end}\n${m.motivo}`}</title>
                </path>
              );
            })}
          </svg>
        </div>
        <Detalhe padrao={(x) => (x.area === "FR" && x.itens.length === 1 ? padraoFr(x) : null)} sel={sel} dep={dep} slots={slots} missoes={abertas} cxpDe={cxpDe} desc={desc} info={infoPi} onFechar={() => setSel(null)} />
      </div>
      {visao === "grupos" && (
        <PainelGrupos slots={slots} grupoDe={grupoDe} familiaDe={familiaDe} cxpDe={cxpDe} coresGrupo={coresGrupo} coresFamilia={coresFamilia} foco={grupoFoco} setFoco={setGrupoFoco} dep={dep} />
      )}
      {precisaRm && giro && <AnaliseGiro estoque={estoque} giro={giro} slots={slots} dep={dep} cxpDe={cxpDe} desc={desc} />}
    </div>
  );
}

function Legenda() {
  const q = (c: string, t: string, extra?: React.CSSProperties) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 }}>
      <span style={{ width: 14, height: 9, background: c, border: "1px solid #cbd5e1", display: "inline-block", ...extra }} />{t}
    </span>
  );
  return (
    <p className="small muted" style={{ margin: "4px 0 0" }}>
      {q("#16a34a", "FR no padrão")}{q("#f97316", "FR fora do padrão (abaixo do mín. ou acima do máx.)")}{q("#d6b98c", "FR sem caixa padrão")}{q("#60a5fa", "SC altura 02 (reposição)")}{q("#1d4ed8", "SC altura 03+ (palete)")}{q("#dc2626", "FR com mais de um PI")}{q("#c026d3", "SC com mais de um PI")}
      {q("#ffffff", "vazia", { borderStyle: "dashed", borderColor: "#94a3b8" })}{q("#facc15", "PI buscado")}
      <span>Número = caixas na LOC (todos os PIs; “+” = sobra de menos de 1 caixa; “?” = PI sem caixa padrão) · Contorno preto = saldo bloqueado · cada coluna tem AA (esquerda) e BB (direita), nível 01 junto do corredor · seta tracejada = onda 2 ou mais. Desenho esquemático.</span>
    </p>
  );
}

function Detalhe({ padrao, sel, dep, slots, missoes, cxpDe, desc, info, onFechar }: {
  padrao: (s: Slot) => { ok: boolean | null; motivo: string } | null;
  sel: { rua: number; col: number } | null; dep: string; slots: Map<string, Slot>; missoes: Missao[];
  cxpDe: (pi: string) => number | undefined; desc: (pi: string) => string; info: (pi: string) => string; onFechar: () => void;
}) {
  if (!sel) return (
    <div className="card" style={{ flex: "0 1 380px", minWidth: 280 }}>
      <p className="muted small" style={{ margin: 0 }}>Clique numa posição do desenho para ver o que tem em cada nível (AA e BB) e as missões que saem ou chegam nela.</p>
    </div>
  );
  const nome = `${dep} · Rua ${String(sel.rua).padStart(2, "0")} · Coluna ${String(sel.col).padStart(2, "0")}`;
  const daPos = [...slots.values()].filter((s) => s.rua === sel.rua && s.col === sel.col).sort((a, b) => b.nivel - a.nivel || a.lado.localeCompare(b.lado));
  const daLoc = (end: string) => missoes.filter((m) => (m.de.dep === dep && m.de.end === end) || (m.para.dep === dep && m.para.end === end));
  const cx = (pi: string, q: number) => { const c = cxpDe(pi); return c ? `${fmtNum(Math.round((q / c) * 10) / 10)} cx` : ""; };
  return (
    <div className="card" style={{ flex: "0 1 420px", minWidth: 300, maxHeight: "78vh", overflow: "auto" }}>
      <div className="bar" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <strong>{nome}</strong>
        <button className="btn" onClick={onFechar}>Fechar</button>
      </div>
      {daPos.length === 0 && <p className="muted small">Nenhum endereço desta posição aparece na planilha.</p>}
      {daPos.map((s) => {
        const ms = daLoc(s.end);
        return (
          <div key={s.key} style={{ borderTop: "1px solid var(--line)", padding: "6px 0" }}>
            <div className="small"><strong>{s.end}</strong> <span className="tag neutral">{s.area === "FR" ? "FR" : s.area === "SC" ? (s.nivel <= 2 ? "SC reposição" : "SC palete") : s.area || "?"}</span>{s.vazia && <span className="tag ok" style={{ marginLeft: 4 }}>vazia</span>}{s.itens.length > 1 && <span className="tag bad" style={{ marginLeft: 4 }}>{s.itens.length} PIs</span>}{(() => { const p = padrao(s); return p ? <span className={`tag ${p.ok === true ? "ok" : p.ok === false ? "warn" : "neutral"}`} style={{ marginLeft: 4 }}>{p.motivo}</span> : null; })()}</div>
            {s.itens.map((i) => (
              <div key={i.pi} className="small" style={{ marginLeft: 8 }}>
                <strong>{i.pi}</strong> {desc(i.pi)} — {fmtNum(i.qtd)} un {cx(i.pi, i.qtd) && <span className="muted">({cx(i.pi, i.qtd)})</span>}{i.bloq > 0 && <span style={{ color: "var(--bad)" }}> · bloqueado {fmtNum(i.bloq)}</span>}
                {info(i.pi) && <div className="muted" style={{ marginLeft: 12 }}>{info(i.pi)}</div>}
              </div>
            ))}
            {ms.map((m) => {
              const sai = m.de.dep === dep && m.de.end === s.end;
              return (
                <div key={m.id + (sai ? "s" : "c")} className="small" style={{ marginLeft: 8, color: sai ? "#b45309" : "#1d4ed8" }}>
                  {sai ? "↗ sai" : "↘ chega"} {m.id} · onda {m.onda} · {m.pi} {fmtNum(m.qtd)} un{m.caixas ? ` (${fmtNum(m.caixas)} cx)` : ""} {sai ? `→ ${m.para.dep} ${m.para.end}` : `← ${m.de.dep} ${m.de.end}`} · {m.status}
                  <div className="muted" style={{ marginLeft: 12 }}>{m.motivo}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------- visão por grupos */

const ruasTexto = (ruas: Set<number>) => [...ruas].sort((a, b) => a - b).map((r) => String(r).padStart(2, "0")).join(", ");
const Amostra = ({ cor }: { cor: string }) => (
  <span style={{ width: 12, height: 9, background: cor, border: "1px solid #cbd5e1", display: "inline-block", marginRight: 5, verticalAlign: "middle" }} />
);

function LegendaGrupos({ slots, grupoDe, familiaDe, dominante, coresGrupo, coresFamilia, foco, setFoco }: {
  slots: Map<string, Slot>; grupoDe: (pi: string) => string; familiaDe: (pi: string) => string; dominante: (s: Slot) => Item;
  coresGrupo: Map<string, string>; coresFamilia: Map<string, string>; foco: string | null; setFoco: (g: string | null) => void;
}) {
  // contagem pelo PI que dá a cor da LOC (o mesmo critério do desenho)
  const cont = new Map<string, number>();
  for (const s of slots.values()) {
    if (!s.itens.length) continue;
    const pi = dominante(s).pi;
    if (foco && grupoDe(pi) !== foco) continue;
    const k = foco ? familiaDe(pi) : grupoDe(pi);
    cont.set(k, (cont.get(k) ?? 0) + 1);
  }
  const cores = foco ? coresFamilia : coresGrupo;
  const outra = foco ? COR_FAMILIA_OUTRAS : COR_OUTROS;
  const lista = [...cont.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const comCor = lista.filter(([k]) => (cores.get(k) ?? outra) !== outra);
  const semCor = lista.filter(([k]) => (cores.get(k) ?? outra) === outra);
  return (
    <div className="small" style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {foco && <button className="chip" onClick={() => setFoco(null)}>← todos os grupos</button>}
      {foco && <strong>{foco}:</strong>}
      {comCor.map(([k, n]) => (
        <button key={k} className="chip" onClick={() => !foco && setFoco(k)} title={foco ? k : "Clique para ver só este grupo, colorido por família"}>
          <Amostra cor={cores.get(k)!} />{k} ({fmtNum(n)})
        </button>
      ))}
      {semCor.length > 0 && <span className="muted"><Amostra cor={outra} />{foco ? "outras famílias" : "outros grupos"}: {fmtNum(semCor.length)} ({fmtNum(semCor.reduce((t, [, n]) => t + n, 0))} LOCs)</span>}
      <span className="muted">· número = caixas na LOC · triângulo no canto = mais de um PI (a cor é a do PI com mais caixas) · {foco ? "cinza claro = outros grupos" : "clique num grupo (aqui ou na tabela abaixo) para isolá-lo e ver as famílias"}</span>
    </div>
  );
}

interface Agrupado { nome: string; fr: number; sc: number; caixas: number; pis: Set<string>; ruas: Set<number> }

function PainelGrupos({ slots, grupoDe, familiaDe, cxpDe, coresGrupo, coresFamilia, foco, setFoco, dep }: {
  slots: Map<string, Slot>; grupoDe: (pi: string) => string; familiaDe: (pi: string) => string; cxpDe: (pi: string) => number | undefined;
  coresGrupo: Map<string, string>; coresFamilia: Map<string, string>; foco: string | null; setFoco: (g: string | null) => void; dep: string;
}) {
  const linhas = useMemo(() => {
    const m = new Map<string, Agrupado>();
    for (const s of slots.values()) {
      const vistos = new Set<string>();
      for (const i of s.itens) {
        if (foco && grupoDe(i.pi) !== foco) continue;
        const k = foco ? familiaDe(i.pi) : grupoDe(i.pi);
        const a = m.get(k) ?? m.set(k, { nome: k, fr: 0, sc: 0, caixas: 0, pis: new Set(), ruas: new Set() }).get(k)!;
        if (!vistos.has(k)) { vistos.add(k); if (s.area === "FR") a.fr++; else if (s.area === "SC") a.sc++; }
        const c = cxpDe(i.pi);
        if (c) a.caixas += i.qtd / c;
        a.pis.add(i.pi);
        a.ruas.add(s.rua);
      }
    }
    return [...m.values()].sort((a, b) => b.fr + b.sc - (a.fr + a.sc) || a.nome.localeCompare(b.nome));
  }, [slots, foco, grupoDe, familiaDe, cxpDe]);
  const cores = foco ? coresFamilia : coresGrupo;
  const outra = foco ? COR_FAMILIA_OUTRAS : COR_OUTROS;
  const baixar = () => {
    const cab = [foco ? "Família" : "Grupo", "LOCs FR", "LOCs SC", "Caixas", "PIs", "Ruas"];
    const corpo = linhas.map((a) => [a.nome, a.fr, a.sc, Math.round(a.caixas), a.pis.size, ruasTexto(a.ruas)]);
    baixarCsv(`${foco ? "familias-" + foco : "grupos"}-${dep}.csv`, cab, corpo);
  };
  return (
    <div className="card">
      <div className="bar" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{foco ? `Famílias do grupo ${foco} no ${dep}` : `Grupos no ${dep}`} ({fmtNum(linhas.length)})</h2>
        <span>{foco && <button className="btn" onClick={() => setFoco(null)} style={{ marginRight: 6 }}>Voltar aos grupos</button>}<button className="btn" onClick={baixar}>Baixar CSV</button></span>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>Muitas ruas para o mesmo {foco ? "família" : "grupo"} = material espalhado pelo paiol. LOCs contam cada posição uma vez por {foco ? "família" : "grupo"}, mesmo com vários PIs.</p>
      <div style={{ maxHeight: 420, overflow: "auto" }}>
        <table>
          <thead><tr><th>{foco ? "Família" : "Grupo"}</th><th className="n">LOCs FR</th><th className="n">LOCs SC</th><th className="n">Caixas</th><th className="n">PIs</th><th className="n">Nº ruas</th><th>Ruas</th></tr></thead>
          <tbody>
            {linhas.map((a) => (
              <tr key={a.nome} onClick={() => !foco && setFoco(a.nome)} style={{ cursor: foco ? undefined : "pointer" }}>
                <td><Amostra cor={cores.get(a.nome) ?? outra} />{a.nome}</td>
                <td className="n">{fmtNum(a.fr)}</td><td className="n">{fmtNum(a.sc)}</td><td className="n">{fmtNum(Math.round(a.caixas))}</td>
                <td className="n">{fmtNum(a.pis.size)}</td><td className="n">{fmtNum(a.ruas.size)}</td><td className="small">{ruasTexto(a.ruas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function baixarCsv(nome: string, cab: string[], corpo: (string | number)[][]) {
  const blob = new Blob(["﻿" + csv([cab, ...corpo])], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* --------------------------------------------------------------------------- visão de giro e cobertura */

function LegendaGiro({ visao, giro, slots, dominante }: { visao: Visao; giro: Giro; slots: Map<string, Slot>; dominante: (s: Slot) => Item }) {
  const cont = new Map<string, number>();
  for (const s of slots.values()) {
    if (!s.itens.length) continue;
    const g = giro.porPi.get(dominante(s).pi);
    if (!g) continue;
    const k = visao === "giro" ? g.classe : faixaCobertura(g);
    cont.set(k, (cont.get(k) ?? 0) + 1);
  }
  const itens: [string, string, string][] = visao === "giro"
    ? (["A", "B", "C", "S"] as ClasseGiro[]).map((c) => [c, COR_CLASSE[c], NOME_CLASSE[c]])
    : FAIXAS_COBERTURA.map((f) => [f.id, COR_FAIXA[f.id], f.nome]);
  return (
    <div className="small" style={{ marginTop: 6 }}>
      {itens.map(([k, c, nome]) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", marginRight: 14 }}><Amostra cor={c} />{nome}: <strong style={{ marginLeft: 4 }}>{fmtNum(cont.get(k) ?? 0)} LOCs</strong></span>
      ))}
      <div className="muted" style={{ marginTop: 4 }}>
        Pedidos de {diaParaData(giro.inicio)} a {diaParaData(giro.fim)} ({fmtNum(giro.dias)} dias), do estoque inteiro (todos os paióis).{" "}
        {visao === "giro"
          ? "Classe pelo número de linhas de pedido do PI: A reúne os PIs que somam 80% das linhas, B os 15% seguintes e C os 5% finais."
          : "Cobertura = saldo do PI em todos os paióis ÷ saída média por dia no período."}{" "}
        A cor é a do PI com mais caixas na LOC; triângulo no canto = mais de um PI.
      </div>
    </div>
  );
}

type ListaId = "parados" | "frBaixo" | "altoSemFr" | "falta" | "excesso";

function AnaliseGiro({ estoque, giro, slots, dep, cxpDe, desc }: {
  estoque: Dados; giro: Giro; slots: Map<string, Slot>; dep: string; cxpDe: (pi: string) => number | undefined; desc: (pi: string) => string;
}) {
  const [lista, setLista] = useState<ListaId>("parados");
  const r = useMemo(() => {
    const frGlobal = new Set<string>();
    for (const l of estoque.linhas) if (estoque.escopos[l.dep] === "estoque" && l.area === "FR" && (l.total > 0 || l.disp > 0)) frGlobal.add(l.pi);
    const porPi = new Map<string, { fr: Set<string>; sc: Set<string>; qtd: number }>();
    let locs = 0, locsParadoFr = 0, locsParadoSc = 0, cxTotal = 0, cxParado = 0;
    const frBaixo: (string | number)[][] = [];
    for (const s of slots.values()) {
      if (!s.itens.length) continue;
      locs++;
      let parado = false;
      for (const i of s.itens) {
        const a = porPi.get(i.pi) ?? porPi.set(i.pi, { fr: new Set(), sc: new Set(), qtd: 0 }).get(i.pi)!;
        (s.area === "FR" ? a.fr : a.sc).add(s.end);
        a.qtd += i.qtd;
        const g = giro.porPi.get(i.pi);
        const c = cxpDe(i.pi);
        const cx = c ? i.qtd / c : 0;
        cxTotal += cx;
        if (g?.classe === "S") { parado = true; cxParado += cx; }
        if (s.area === "FR" && g && (g.classe === "S" || g.classe === "C"))
          frBaixo.push([s.end, i.pi, desc(i.pi), g.classe === "S" ? "sem saída" : "C", g.pedidos, diaParaData(g.ultimoDia), c ? Math.round(cx * 10) / 10 : "?"]);
      }
      if (parado) { if (s.area === "FR") locsParadoFr++; else locsParadoSc++; }
    }
    const linhaPi = (pi: string, g: GiroPi, a: { fr: Set<string>; sc: Set<string>; qtd: number }) => {
      const c = cxpDe(pi);
      return [pi, desc(pi), g.classe === "S" ? "sem saída" : g.classe, g.pedidos, g.unidades, diaParaData(g.ultimoDia), g.saldo, g.cobertura === null ? "—" : Math.round(g.cobertura), a.fr.size, a.sc.size, c ? Math.round(a.qtd / c) : "?"];
    };
    const pisPaiol = [...porPi.entries()].map(([pi, a]) => ({ pi, a, g: giro.porPi.get(pi)! })).filter((x) => x.g);
    const cxDe = (x: { pi: string; a: { qtd: number } }) => { const c = cxpDe(x.pi); return c ? x.a.qtd / c : 0; };
    const ordCx = (a: { pi: string; a: { qtd: number } }, b: { pi: string; a: { qtd: number } }) => cxDe(b) - cxDe(a) || b.a.qtd - a.a.qtd;
    const listas: Record<ListaId, (string | number)[][]> = {
      parados: pisPaiol.filter((x) => x.g.classe === "S").sort(ordCx).map((x) => linhaPi(x.pi, x.g, x.a)),
      frBaixo: frBaixo.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      altoSemFr: pisPaiol.filter((x) => x.g.classe === "A" && !frGlobal.has(x.pi)).sort((a, b) => b.g.pedidos - a.g.pedidos).map((x) => linhaPi(x.pi, x.g, x.a)),
      falta: pisPaiol.filter((x) => x.g.cobertura !== null && x.g.cobertura < 30).sort((a, b) => a.g.cobertura! - b.g.cobertura!).map((x) => linhaPi(x.pi, x.g, x.a)),
      excesso: pisPaiol.filter((x) => x.g.cobertura !== null && x.g.cobertura >= 365).sort(ordCx).map((x) => linhaPi(x.pi, x.g, x.a)),
    };
    return { listas, locs, locsParadoFr, locsParadoSc, cxTotal, cxParado, pis: pisPaiol.length, parados: listas.parados.length };
  }, [estoque, giro, slots, cxpDe, desc]);

  const CAB_PI = ["PI", "Descrição", "Classe", "Pedidos", "Un. pedidas", "Última saída", "Saldo total", "Cobertura (dias)", "LOCs FR no paiol", "LOCs SC no paiol", "Caixas no paiol"];
  const DEFS: Record<ListaId, { nome: string; explica: string; cab: string[] }> = {
    parados: { nome: "Parados (sem saída)", explica: "PIs com saldo neste paiol e nenhuma linha de pedido no período, dos que mais ocupam caixas para os que menos ocupam. Candidatos a ir para as alturas de cima, para outro paiol ou para revisão.", cab: CAB_PI },
    frBaixo: { nome: "Baixo giro ocupando o FR", explica: "LOCs do FR deste paiol ocupadas por PI de classe C ou sem saída. Liberar essas LOCs abre espaço no picking para itens de mais saída.", cab: ["LOC", "PI", "Descrição", "Classe", "Pedidos", "Última saída", "Caixas na LOC"] },
    altoSemFr: { nome: "Alto giro sem LOC no FR", explica: "PIs de classe A com saldo neste paiol e sem nenhuma LOC no FR (em nenhum paiol): toda saída depende de abrir caixa no SC.", cab: CAB_PI },
    falta: { nome: "Risco de falta", explica: "PIs deste paiol cujo saldo total cobre menos de 30 dias da saída média do período.", cab: CAB_PI },
    excesso: { nome: "Excesso de estoque", explica: "PIs deste paiol com saldo para mais de 1 ano de saída no ritmo do período, dos que mais ocupam caixas.", cab: CAB_PI },
  };
  const def = DEFS[lista];
  const linhas = r.listas[lista];
  const MAX = 200;
  const pctx = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  return (
    <div className="card">
      <h2>Saída (RM) × estoque no {dep}</h2>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginBottom: 10 }}>
        <div className="card kpi"><div className="v">{fmtNum(r.pis)}</div><div className="l">PIs com saldo no paiol</div></div>
        <div className="card kpi warn"><div className="v">{fmtNum(r.parados)}</div><div className="l">sem saída no período ({pctx(r.parados, r.pis)})</div></div>
        <div className="card kpi warn"><div className="v">{fmtNum(r.locsParadoFr + r.locsParadoSc)}</div><div className="l">LOCs com PI parado ({fmtNum(r.locsParadoFr)} FR, {fmtNum(r.locsParadoSc)} SC) de {fmtNum(r.locs)} ocupadas</div></div>
        <div className="card kpi warn"><div className="v">{fmtNum(Math.round(r.cxParado))}</div><div className="l">caixas paradas ({pctx(r.cxParado, r.cxTotal)} das caixas do paiol)</div></div>
      </div>
      <div className="chips" role="group" aria-label="Lista" style={{ marginBottom: 6 }}>
        {(Object.keys(DEFS) as ListaId[]).map((k) => (
          <button key={k} className="chip" aria-pressed={lista === k} onClick={() => setLista(k)}>{DEFS[k].nome} ({fmtNum(r.listas[k].length)})</button>
        ))}
        <button className="btn" style={{ marginLeft: "auto" }} onClick={() => baixarCsv(`${lista}-${dep}.csv`, def.cab, linhas)}>Baixar CSV</button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>{def.explica}</p>
      <div style={{ maxHeight: 460, overflow: "auto" }}>
        <table>
          <thead><tr>{def.cab.map((c, i) => <th key={c} className={i >= 3 && c !== "Última saída" ? "n" : undefined}>{c}</th>)}</tr></thead>
          <tbody>
            {linhas.slice(0, MAX).map((l, k) => (
              <tr key={k}>{l.map((v, i) => <td key={i} className={typeof v === "number" ? "n" : undefined}>{typeof v === "number" ? fmtNum(v) : v}</td>)}</tr>
            ))}
          </tbody>
        </table>
        {linhas.length === 0 && <p className="muted small">Nenhum item nesta lista.</p>}
        {linhas.length > MAX && <p className="muted small">Mostrando {MAX} de {fmtNum(linhas.length)}. Baixe o CSV para ver todos.</p>}
      </div>
    </div>
  );
}
