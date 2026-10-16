"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { NOME_DEPOSITO } from "@/lib/config";
import type { Missao, Parametros } from "@/lib/missoes";
import { CALCADOS_PRIMEIRA_PALAVRA } from "@/lib/config";
import type { Dados } from "@/lib/types";
import { fmtNum } from "@/lib/util";
import { Carga } from "./Missoes";

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
  return <Carga>{(d) => <Mapa estoque={estoque} missoes={d.missoes} params={d.params} />}</Carga>;
}

// geometria (unidades do SVG; o zoom só escala)
const CW = 30; // largura de uma posição (coluna): AA + BB
const LH = 8; // altura de um nível
const CORREDOR = 30;
const MARGEM = 54;

function Mapa({ estoque, missoes, params }: { estoque: Dados; missoes: Missao[]; params: Parametros }) {
  const porDep = useMemo(() => montarSlots(estoque), [estoque]);
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
    if (s.itens.length > 1) return "#dc2626";
    if (s.area === "FR") { const p = padraoFr(s).ok; return p === true ? "#16a34a" : p === false ? "#f97316" : "#d6b98c"; }
    if (s.area === "SC") return s.nivel <= 2 ? "#60a5fa" : "#1d4ed8";
    return "#94a3b8";
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
      mistas: ocup.filter((s) => s.itens.length > 1).length,
      bloq: ocup.filter((s) => s.itens.some((i) => i.bloq > 0)).length,
    };
  }, [slots]);
  const porFluxo = useMemo(() => {
    const c: Record<Fluxo, number> = { recomp: 0, frfr: 0, devolucao: 0, descer: 0, sc: 0 };
    for (const m of abertas) c[tipoFluxo(m, frLocs)]++;
    return c;
  }, [abertas, frLocs]);

  const ruaVisivel = (l: { dep: string; end: string }) => l.dep === dep && (rua === "" || Number(l.end.split("-")[0]) === rua);
  const desenhadas = visiveis.filter((m) => (!soDaSelecao || tocaSel(m)) && (ruaVisivel(m.de) || ruaVisivel(m.para)));
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
          {fmtNum(resumo.total)} posições conhecidas · {fmtNum(resumo.fr)} FR (<span style={{ color: "#16a34a" }}>{fmtNum(resumo.frOk)} no padrão</span>, <span style={{ color: "#ea580c" }}>{fmtNum(resumo.frFora)} fora</span>) e {fmtNum(resumo.sc)} SC ocupadas · {fmtNum(resumo.vazias)} vazias · <span style={{ color: "#dc2626" }}>{fmtNum(resumo.mistas)} com mais de um PI</span> · {fmtNum(resumo.bloq)} com bloqueio · {fmtNum(abertas.length)} missões abertas no paiol
          {desenhadas.length > LIMITE && <> · <strong>mostrando {LIMITE} de {fmtNum(desenhadas.length)} fluxos</strong> (filtre por rua, onda ou tipo)</>}
        </p>
        <Legenda />
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
              return (
                <rect key={s.key} x={g.x} y={g.y} width={g.w} height={g.h} rx={1}
                  fill={realce ? "#facc15" : cor(s)} stroke={selec ? "#111" : bloq ? "#111" : s.vazia ? "#94a3b8" : "#cbd5e1"}
                  strokeWidth={selec ? 1.6 : bloq ? 1 : 0.6} strokeDasharray={s.vazia ? "2 1" : undefined}
                  style={{ cursor: "pointer" }} onClick={() => setSel({ rua: s.rua, col: s.col })}>
                  <title>{titulo}</title>
                </rect>
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
        <Detalhe padrao={(x) => (x.area === "FR" && x.itens.length === 1 ? padraoFr(x) : null)} sel={sel} dep={dep} slots={slots} missoes={abertas} cxpDe={cxpDe} desc={desc} onFechar={() => setSel(null)} />
      </div>
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
      {q("#16a34a", "FR no padrão")}{q("#f97316", "FR fora do padrão (abaixo do mín. ou acima do máx.)")}{q("#d6b98c", "FR sem caixa padrão")}{q("#60a5fa", "SC altura 02 (reposição)")}{q("#1d4ed8", "SC altura 03+ (palete)")}{q("#dc2626", "mais de um PI")}
      {q("#ffffff", "vazia", { borderStyle: "dashed", borderColor: "#94a3b8" })}{q("#facc15", "PI buscado")}
      <span>Contorno preto = saldo bloqueado · cada coluna tem AA (esquerda) e BB (direita), nível 01 junto do corredor · seta tracejada = onda 2 ou mais. Desenho esquemático.</span>
    </p>
  );
}

function Detalhe({ padrao, sel, dep, slots, missoes, cxpDe, desc, onFechar }: {
  padrao: (s: Slot) => { ok: boolean | null; motivo: string } | null;
  sel: { rua: number; col: number } | null; dep: string; slots: Map<string, Slot>; missoes: Missao[];
  cxpDe: (pi: string) => number | undefined; desc: (pi: string) => string; onFechar: () => void;
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
