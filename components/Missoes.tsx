"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ABERTA, STATUS_MISSAO, type Alerta, type AvisoValidacao, type Conformidade, type Missao, type Parametros, type StatusMissao, type TipoMissao,
} from "@/lib/missoes";
import { chaveRota } from "@/lib/rota";
import type { Dados } from "@/lib/types";
import { NOME_DEPOSITO } from "@/lib/config";
import { csv, fmtDataHora, fmtNum, norm } from "@/lib/util";

/* ------------------------------------------------------------------ estado compartilhado */

interface ResumoPlano { ativos: number; comCasa: number; naZona: number; semLugar: number }

interface Resposta {
  missoes: Missao[];
  params: Parametros;
  alertas: Alerta[];
  conformidade: Conformidade | null;
  resumo: ResumoPlano | null;
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
    "Padrão: cada PI com pedido fracionado tem uma LOC FR só dele, com no mínimo 1 caixa e no máximo 5 (calçados: no máximo 3, por serem caixas grandes).",
    "Quando a LOC do PI fica abaixo do mínimo, o sistema leva caixas fechadas de SC até cobrir alguns pedidos fracionados médios (parâmetro), sempre entre o mínimo e o máximo.",
    "A média por pedido é a média da quantidade fracionada por pedido (não por dia), porque a maioria dos itens é sazonal. A frequência mostra a cadência dos pedidos fracionados.",
    "Caixas de SC: mesmo paiol primeiro, depois a validade mais próxima (FEFO). Faltou LOC? Os PIs de menor saída vão para a zona de baixo giro (rua 01 do P02), com 2 caixas.",
  ],
  movimentacao: [
    "Objetivo: 1 PI por LOC FR, com 1 a 5 caixas (calçado 1 a 3). O sistema define sozinho a LOC \"casa\" de cada PI com o menor esforço: mantém onde o PI já está sozinho e move o mínimo.",
    "Juntar: o PI espalhado vai para a sua casa. Desmisturar: em LOC com mais de um PI, fica o dono da LOC e os outros vão para a casa deles. O que passa do máximo volta para o SC.",
    "Tudo que volta do FR para o SC é sempre em CAIXAS FECHADAS (múltiplo da quantidade padrão por caixa, CXP). Unidades soltas, menos de 1 caixa, nunca voltam ao SC: seguem para a LOC do PI, e se ela passar do máximo, ela devolve uma caixa fechada.",
    "Onda 1 pode ser feita já; onda 2 só depois que a onda 1 liberar a LOC de destino (ou trouxer o saldo de onde sai a devolução). Trocas entre duas LOCs vêm marcadas para fazer juntas.",
    "Faltou LOC? PIs de menor saída vão para a zona de baixo giro (rua 01 do P02); sem espaço nem lá, o saldo volta ao SC e aparece um alerta. Ficam de fora o P04 e a rua 12 do P02.",
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
            <Parametrologia tipo={tipo} params={d.params} resumo={d.resumo} />
            {d.rmErro && <div className="note">Missões automáticas desativadas: {d.rmErro}. As manuais continuam funcionando.</div>}
            {sub === "lista" ? <Lista tipo={tipo} missoes={d.missoes.filter((m) => m.tipo === tipo)} geradoEm={d.geradoEm} estoqueEm={d.estoqueEm} /> : <Manual tipo={tipo} estoque={estoque} onCriada={() => setSub("lista")} />}
          </>
        )}
      </Carga>
    </div>
  );
}

/* --------------------------------------------------------------------- parâmetros */

function Parametrologia({ tipo, params, resumo }: { tipo: TipoMissao; params: Parametros; resumo: ResumoPlano | null }) {
  const { post, recarregar } = usar();
  const [p, setP] = useState(params);
  const texto = (l: { dep: string; end: string }[]) => l.map((x) => `${x.dep} ${x.end}`).join("\n");
  const [vazias, setVazias] = useState(texto(params.locsVazias));
  const [vaziasSc, setVaziasSc] = useState(texto(params.locsVaziasSc));
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setP(params); setVazias(texto(params.locsVazias)); setVaziasSc(texto(params.locsVaziasSc)); }, [params]);

  const lerLocs = (t: string) => t.split("\n").map((l) => l.trim().split(/\s+/)).filter((a) => a.length >= 2).map(([dep, end]) => ({ dep, end }));

  async function salvar(extra?: Partial<Parametros>) {
    setSalvando(true);
    setMsg(null);
    const r = await post({ acao: "params", params: { ...p, locsVazias: lerLocs(vazias), locsVaziasSc: lerLocs(vaziasSc), ...extra } });
    setSalvando(false);
    if (!r.ok) { setMsg(r.json.erro || "Falha ao salvar"); return; }
    setMsg("Salvo. Replanejando as missões…");
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

  const num = (k: "maxCaixas" | "minCaixas" | "maxCaixasCalcado" | "minCaixasCalcado" | "pedidosCobertura" | "caixasZona" | "pisPorLocZona", rot: string, dica?: string) => (
    <label title={dica}>
      {rot}
      <input type="number" min={1} value={p[k]} style={{ width: 90 }} onChange={(e) => setP({ ...p, [k]: +e.target.value })} />
    </label>
  );
  const area = (rot: string, v: string, set: (t: string) => void, ph: string) => (
    <label style={{ flex: "1 1 240px" }}>
      {rot}
      <textarea value={v} rows={4} onChange={(e) => set(e.target.value)} placeholder={ph} style={{ padding: 7, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)", font: "inherit" }} />
    </label>
  );

  return (
    <details className="card">
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Regras e parâmetros (compartilhados por todos)</summary>
      <ul style={{ margin: "8px 0 8px 18px", padding: 0 }}>{REGRAS[tipo].map((t) => <li key={t}>{t}</li>)}</ul>
      {resumo && (
        <p className="small" style={{ margin: "4px 0 8px" }}>
          <strong>Plano atual:</strong> {fmtNum(resumo.ativos)} PIs com pedido fracionado · {fmtNum(resumo.comCasa)} com LOC própria · {fmtNum(resumo.naZona)} na zona de baixo giro · {fmtNum(resumo.semLugar)} sem lugar.
        </p>
      )}
      <div className="filters" style={{ padding: 0, marginBottom: 0 }}>
        {num("minCaixas", "Mínimo de caixas")}
        {num("maxCaixas", "Máximo de caixas")}
        {num("minCaixasCalcado", "Mínimo (calçado)")}
        {num("maxCaixasCalcado", "Máximo (calçado)")}
        {num("pedidosCobertura", "Pedidos médios a cobrir", "O recompletamento leva a LOC até este número de pedidos fracionados médios (entre o mínimo e o máximo)")}
        {num("caixasZona", "Caixas na zona", "Caixas de cada PI na zona de baixo giro (rua 01 do P02)")}
        {num("pisPorLocZona", "PIs por LOC da zona")}
      </div>
      <div className="filters" style={{ padding: 0, marginBottom: 0 }}>
        {area("LOCs FR vazias disponíveis (PAIOL ENDEREÇO, uma por linha)", vazias, setVazias, "P02 01-10-01-AA\nP02 05-10-01-BB")}
        {area("LOCs SC vazias para devolver excedentes", vaziasSc, setVaziasSc, "P02 08-01-01-AA")}
      </div>
      <div className="bar" style={{ marginTop: 8, marginBottom: 0 }}>
        <button className="btn" onClick={() => salvar()} disabled={salvando}>{salvando ? "Salvando…" : "Salvar e replanejar"}</button>
        <button className="btn" onClick={importarLocal} disabled={salvando} title="Copia para o servidor o máximo de caixas por PI ajustado na aba Análise de RM deste navegador">Importar ajustes por PI deste navegador</button>
        <span className="muted small">{Object.keys(p.caixasPorPi).length} PI(s) com máximo próprio. {msg}</span>
      </div>
      <p className="muted small">A planilha só mostra LOCs com saldo. LOCs vazias informadas aqui entram como destino possível; sem elas o sistema só usa LOCs que já aparecem na planilha.</p>
    </details>
  );
}

/* ----------------------------------------------------------------------- listagem */

type Filtro = "abertas" | "concluidas" | "canceladas" | "todas";
const POR_PAGINA = 100;
const STATUS_MANUAIS: StatusMissao[] = ["pendente", "em_execucao", "feita", "cancelada"];

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Folha para os estivadores: por onda e paiol de origem, na ordem do caminho físico, com caixa de marcar. */
function imprimir(titulo: string, missoes: Missao[], estoqueEm: string | null) {
  const w = window.open("", "_blank");
  if (!w) { alert("O navegador bloqueou a janela de impressão. Libere pop-ups para este site."); return; }
  const ordenadas = [...missoes].sort((a, b) => a.onda - b.onda || a.de.dep.localeCompare(b.de.dep) || chaveRota(a.de.end).localeCompare(chaveRota(b.de.end)) || a.id.localeCompare(b.id));
  const grupos = new Map<string, Missao[]>();
  for (const m of ordenadas) (grupos.get(`${m.onda}|${m.de.dep}`) ?? grupos.set(`${m.onda}|${m.de.dep}`, []).get(`${m.onda}|${m.de.dep}`)!).push(m);
  const agora = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const secoes = [...grupos.entries()].map(([k, ms]) => {
    const [onda, dep] = k.split("|");
    const linhas = ms.map((m) => `<tr>
      <td class="ck">☐</td><td>${esc(m.id)}${m.nota ? `<div class="n">${esc(m.nota)}</div>` : ""}</td>
      <td><b>${esc(m.pi)}</b><div>${esc(m.desc)}</div></td>
      <td class="r"><b>${esc(fmtNum(m.qtd))}</b> un${m.caixas ? `<div>${esc(fmtNum(m.caixas))} cx</div>` : ""}</td>
      <td><b>${esc(m.de.dep)}</b> ${esc(m.de.end)}</td><td><b>${esc(m.para.dep)}</b> ${esc(m.para.end)}</td>
      <td>${esc(m.lote)}${m.validade ? `<div>${esc(m.validade.split("-").reverse().join("/"))}</div>` : ""}</td>
      <td class="obs">${esc(m.obs)}</td></tr>`).join("");
    return `<h2>Onda ${esc(onda)} · origem ${esc(dep)} <small>(${ms.length} missão(ões)${onda === "2" ? " — só depois de concluir a onda 1" : ""})</small></h2>
      <table><thead><tr><th></th><th>Missão</th><th>PI / Descrição</th><th>Qtd</th><th>De</th><th>Para</th><th>Lote / Val.</th><th>Obs.</th></tr></thead><tbody>${linhas}</tbody></table>`;
  }).join("");
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>
    @page { size: A4 landscape; margin: 10mm; }
    body { font: 11px/1.3 Arial, sans-serif; color: #000; }
    h1 { font-size: 16px; margin: 0 0 2px; } .sub { color: #444; margin-bottom: 8px; }
    h2 { font-size: 13px; margin: 14px 0 4px; border-bottom: 2px solid #000; padding-bottom: 2px; } h2 small { font-weight: normal; color: #444; }
    table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #888; padding: 3px 5px; text-align: left; vertical-align: top; }
    th { background: #eee; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
    .ck { width: 16px; text-align: center; font-size: 15px; } .r { text-align: right; white-space: nowrap; } .obs { width: 18%; } .n { font-size: 9px; color: #444; }
  </style></head><body>
    <h1>${esc(titulo)}</h1>
    <div class="sub">Impresso em ${esc(agora)} · estoque de ${esc(fmtDataHora(estoqueEm))} · ${ordenadas.length} missão(ões) · ordenadas pelo caminho físico (rua, coluna, nível, lado)</div>
    ${secoes || "<p>Nenhuma missão.</p>"}
    <p style="margin-top:14px">Responsável: ____________________________ &nbsp; Data: ____/____/______ &nbsp; Visto: ______________</p>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

function Lista({ tipo, missoes, geradoEm, estoqueEm }: { tipo: TipoMissao; missoes: Missao[]; geradoEm: string; estoqueEm: string | null }) {
  const { post, trocar, recarregar, carregando } = usar();
  const [filtro, setFiltro] = useState<Filtro>("abertas");
  const [q, setQ] = useState("");
  const [origem, setOrigem] = useState<"" | "auto" | "manual">("");
  const [onda, setOnda] = useState<"" | "1" | "2">("");
  const [status, setStatus] = useState<"" | StatusMissao>("");
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [pag, setPag] = useState(0);

  const cont = useMemo(() => ({
    abertas: missoes.filter((m) => ABERTA(m.status)).length,
    pendentes: missoes.filter((m) => m.status === "pendente").length,
    exec: missoes.filter((m) => m.status === "em_execucao" || m.status === "feita").length,
    onda1: missoes.filter((m) => ABERTA(m.status) && m.onda === 1).length,
    onda2: missoes.filter((m) => ABERTA(m.status) && m.onda === 2).length,
    div: missoes.filter((m) => m.status === "divergente").length,
    concluidas: missoes.filter((m) => m.status === "concluida").length,
    canceladas: missoes.filter((m) => m.status === "cancelada").length,
  }), [missoes]);

  const lista = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return missoes
      .filter((m) => (filtro === "abertas" ? ABERTA(m.status) || m.status === "feita" : filtro === "concluidas" ? m.status === "concluida" : filtro === "canceladas" ? m.status === "cancelada" : true))
      .filter((m) => !origem || m.origem === origem)
      .filter((m) => !onda || String(m.onda) === onda)
      .filter((m) => !status || m.status === status)
      .filter((m) => !toks.length || toks.every((t) => norm(`${m.id} ${m.pi} ${m.desc} ${m.de.end} ${m.para.end} ${m.responsavel} ${m.obs} ${m.motivo}`).includes(t)));
  }, [missoes, filtro, q, origem, onda, status]);
  useEffect(() => setPag(0), [filtro, q, origem, onda, status, missoes.length]);
  const pagina = lista.slice(pag * POR_PAGINA, (pag + 1) * POR_PAGINA);
  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));

  async function alterar(m: Missao, campos: Record<string, unknown>) {
    setErro(null);
    const r = await post({ acao: "alterar", id: m.id, campos });
    if (!r.ok) { setErro(r.json.erro || "Falha ao salvar"); return; }
    trocar(r.json.missao);
  }

  function exportar() {
    const cab = ["Missão", "Onda", "Prioridade", "Status", "PI", "Descrição", "Quantidade (un)", "Caixas", "De (paiol)", "De (endereço)", "Para (paiol)", "Para (endereço)", "Lote", "Validade", "Origem da missão", "Responsável", "Observação", "Motivo", "Nota do sistema", "Criada em"];
    const corpo = lista.map((m) => [m.id, m.onda, PRIO[m.prioridade].nome, STATUS_MISSAO.find((s) => s.id === m.status)!.nome, m.pi, m.desc, String(m.qtd).replace(".", ","), m.caixas ?? "", m.de.dep, m.de.end, m.para.dep, m.para.end, m.lote, m.validade, m.origem === "auto" ? "Automática" : "Manual", m.responsavel, m.obs, m.motivo, m.nota, fmtDataHora(m.criadaEm)]);
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
        <div className="card kpi warn"><div className="v">{fmtNum(cont.pendentes)}</div><div className="l">Pendentes · onda 1: {fmtNum(cont.onda1)} · onda 2: {fmtNum(cont.onda2)}</div></div>
        <div className="card kpi"><div className="v">{fmtNum(cont.exec)}</div><div className="l">Em execução ou feitas (aguardando a planilha confirmar)</div></div>
        <div className="card kpi ok"><div className="v">{fmtNum(cont.concluidas)}</div><div className="l">Confirmadas pela planilha · {fmtNum(cont.canceladas)} canceladas</div></div>
        <div className="card kpi bad"><div className="v">{fmtNum(cont.div)}</div><div className="l">Divergentes (a planilha não bateu)</div></div>
      </div>
      <div className="card">
        {erro && <div className="note" style={{ background: "var(--bad-soft)", color: "var(--bad)" }}>{erro}</div>}
        <div className="bar" style={{ justifyContent: "space-between" }}>
          <div className="seg" role="group" aria-label="Filtro">
            <button aria-pressed={filtro === "abertas"} onClick={() => setFiltro("abertas")}>Abertas ({fmtNum(cont.abertas + missoes.filter((m) => m.status === "feita").length)})</button>
            <button aria-pressed={filtro === "concluidas"} onClick={() => setFiltro("concluidas")}>Confirmadas</button>
            <button aria-pressed={filtro === "canceladas"} onClick={() => setFiltro("canceladas")}>Canceladas</button>
            <button aria-pressed={filtro === "todas"} onClick={() => setFiltro("todas")}>Todas</button>
          </div>
          <input type="search" placeholder="Buscar missão, PI, endereço, responsável…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220, flex: "1 1 220px" }} />
          <select value={onda} onChange={(e) => setOnda(e.target.value as typeof onda)} aria-label="Onda"><option value="">Todas as ondas</option><option value="1">Onda 1</option><option value="2">Onda 2</option></select>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status"><option value="">Todos os status</option>{STATUS_MISSAO.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}</select>
          <select value={origem} onChange={(e) => setOrigem(e.target.value as typeof origem)} aria-label="Origem da missão"><option value="">Automáticas e manuais</option><option value="auto">Só automáticas</option><option value="manual">Só manuais</option></select>
        </div>
        <div className="bar" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => imprimir(`${NOME_TIPO[tipo]} — folha de missões`, lista, estoqueEm)} disabled={!lista.length} title="Abre a folha para imprimir, por onda e paiol, na ordem do caminho físico">🖨 Imprimir {fmtNum(lista.length)} missão(ões)</button>
          <button className="btn" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
          <button className="btn" onClick={recarregar} disabled={carregando}>{carregando ? "Atualizando…" : "Atualizar"}</button>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Onda</th><th>Prio.</th><th>Missão</th><th>PI</th><th className="n">{tipo === "recompletamento" ? "Caixas" : "Qtd (caixas se SC)"}</th><th>De</th><th>Para</th>
                <th>Status</th><th>Responsável</th><th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {pagina.map((m) => (
                <MissaoLinha key={m.id} m={m} tipo={tipo} aberto={aberto === m.id} onToggle={() => setAberto(aberto === m.id ? null : m.id)} onAlterar={alterar} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted small">{lista.length ? `${fmtNum(pag * POR_PAGINA + 1)}–${fmtNum(Math.min(lista.length, (pag + 1) * POR_PAGINA))} de ${fmtNum(lista.length)}` : "Nenhuma missão neste filtro"}</span>
          <span style={{ display: "flex", gap: 6 }}>
            <button disabled={pag === 0} onClick={() => setPag(pag - 1)}>← Anterior</button>
            <button disabled={pag >= paginas - 1} onClick={() => setPag(pag + 1)}>Próxima →</button>
          </span>
        </div>
        <p className="muted small">
          As missões são planejadas pelo sistema a cada carga (estoque de {fmtDataHora(estoqueEm)}, gerado em {fmtDataHora(geradoEm)}). A cada planilha nova o sistema confere sozinho o que foi feito:
          <strong> confirmada</strong> (saiu e chegou), <strong>parcial</strong> (a missão passa a pedir só o que falta) ou <strong>divergente</strong> (a planilha não bateu). As missões que continuam valendo mantêm o mesmo número.
        </p>
      </div>
    </>
  );
}

function MissaoLinha({ m, tipo, aberto, onToggle, onAlterar }: { m: Missao; tipo: TipoMissao; aberto: boolean; onToggle: () => void; onAlterar: (m: Missao, c: Record<string, unknown>) => void }) {
  const encerrada = m.status === "concluida" || m.status === "cancelada";
  const opcoes = STATUS_MISSAO.filter((s) => STATUS_MANUAIS.includes(s.id) || s.id === m.status);
  return (
    <>
      <tr className="click" onClick={onToggle} style={encerrada ? { opacity: 0.6 } : undefined}>
        <td><span className={`tag ${m.onda === 1 ? "ok" : "neutral"}`} title={m.onda === 2 ? "Só depois que a onda 1 liberar a LOC de destino" : "Pode ser feita já"}>{m.onda}</span></td>
        <td><span className={`tag ${PRIO[m.prioridade].tom}`}>{PRIO[m.prioridade].nome}</span></td>
        <td>{aberto ? "▾" : "▸"} {m.id}{m.origem === "manual" && <span className="tag neutral" style={{ marginLeft: 4 }}>manual</span>}</td>
        <td className="wrapc"><strong>{m.pi}</strong> {m.desc}{m.freq && m.freq !== "—" && <div className="muted small">{m.freq}{m.qtdMediaPedido ? ` · média ${fmtNum(m.qtdMediaPedido)} un/pedido` : ""}</div>}</td>
        <td className="n">{m.caixas ? <>{fmtNum(m.caixas)} cx <span className="muted small">({fmtNum(m.qtd)} un)</span></> : `${fmtNum(m.qtd)} un`}</td>
        <td title={NOME_DEPOSITO[m.de.dep]}>{loc(m.de)}</td>
        <td title={NOME_DEPOSITO[m.para.dep]}>{loc(m.para)}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select value={m.status} onChange={(e) => onAlterar(m, { status: e.target.value as StatusMissao })} aria-label={`Status da missão ${m.id}`}
            style={m.status === "divergente" ? { borderColor: "var(--bad)", color: "var(--bad)" } : m.status === "concluida" ? { borderColor: "var(--ok)", color: "var(--ok)" } : undefined}>
            {opcoes.map((s) => <option key={s.id} value={s.id} disabled={!STATUS_MANUAIS.includes(s.id)}>{s.nome}</option>)}
          </select>
        </td>
        <td onClick={(e) => e.stopPropagation()}><Campo valor={m.responsavel} largura={110} rotulo={`Responsável pela missão ${m.id}`} onSalvar={(v) => onAlterar(m, { responsavel: v })} /></td>
        <td onClick={(e) => e.stopPropagation()}><Campo valor={m.obs} largura={180} rotulo={`Observação da missão ${m.id}`} onSalvar={(v) => onAlterar(m, { obs: v })} /></td>
      </tr>
      {aberto && (
        <tr className="sub">
          <td colSpan={10}>
            <p style={{ margin: "4px 0" }}><strong>Por quê:</strong> {m.motivo}</p>
            {m.nota && <p style={{ margin: "4px 0", color: m.status === "divergente" ? "var(--bad)" : undefined }}><strong>Sistema:</strong> {m.nota}</p>}
            <p className="muted small" style={{ margin: "4px 0" }}>
              {m.lote && <>Lote {m.lote}{m.validade ? ` · validade ${m.validade.split("-").reverse().join("/")}` : ""} · </>}
              {m.idQuant && <>ID_QUANT {m.idQuant} · </>}
              criada {fmtDataHora(m.criadaEm)}{m.verificadaEm ? ` · confirmada ${fmtDataHora(m.verificadaEm)}` : m.concluidaEm ? ` · feita ${fmtDataHora(m.concluidaEm)}` : ""}
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
      {(d) => <AlertasLista alertas={d.alertas} conf={d.conformidade} resumo={d.resumo} />}
    </Carga>
  );
}

function AlertasLista({ alertas, conf, resumo }: { alertas: Alerta[]; conf: Conformidade | null; resumo: ResumoPlano | null }) {
  const { recarregar, carregando } = usar();
  const [tipo, setTipo] = useState<"" | TipoMissao>("");
  const lista = alertas.filter((a) => !tipo || !a.tipo || a.tipo === tipo);
  return (
    <div className="grid" style={{ gap: 12 }}>
      {conf && (
        <div className="card">
          <h2>Aderência ao padrão (1 PI por LOC, entre o mínimo e o máximo de caixas)</h2>
          <div className="grid g4">
            <div className="kpi"><div className="v">{conf.locs ? `${Math.round((conf.conformes / conf.locs) * 100)}%` : "—"}</div><div className="l">{fmtNum(conf.conformes)} de {fmtNum(conf.locs)} LOCs FR de PIs fracionados estão no padrão hoje</div></div>
            <div className="kpi warn"><div className="v">{fmtNum(conf.maisDeUmPi)}</div><div className="l">LOCs com mais de um PI</div></div>
            <div className="kpi warn"><div className="v">{fmtNum(conf.acimaDoMaximo)} / {fmtNum(conf.abaixoDoMinimo)}</div><div className="l">PIs acima do máximo / abaixo do mínimo de caixas</div></div>
            <div className="kpi bad"><div className="v">{fmtNum(conf.pisSemLoc)}</div><div className="l">PIs com fracionado e saldo, sem LOC FR</div></div>
          </div>
          {resumo && <p className="muted small" style={{ marginBottom: 0 }}>Plano: {fmtNum(resumo.ativos)} PIs com pedido fracionado · {fmtNum(resumo.comCasa)} com LOC própria · {fmtNum(resumo.naZona)} na zona de baixo giro · {fmtNum(resumo.semLugar)} sem lugar.</p>}
        </div>
      )}
      <div className="bar" style={{ marginBottom: 0, justifyContent: "space-between" }}>
        <p className="muted small" style={{ margin: 0 }}>Cada alerta indica uma regra que está sendo quebrada ou prestes a ser, incluindo casos novos que fogem do padrão a cada planilha. Recalculados toda vez que as missões são atualizadas.</p>
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
