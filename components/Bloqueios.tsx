"use client";

import { useEffect, useMemo, useState } from "react";
import { STATUS_TRATATIVA, type Registro, type StatusTratativa } from "@/lib/bloqueios";
import { NOME_DEPOSITO } from "@/lib/config";
import { csv, fmtDataHora, fmtNum, norm } from "@/lib/util";

type Visao = "abertos" | "saiu" | "resolvidos" | "todos";

const NOME_STATUS = Object.fromEntries(STATUS_TRATATIVA.map((s) => [s.id, s.nome])) as Record<StatusTratativa, string>;
const TOM: Record<StatusTratativa, string> = { pendente: "bad", em_busca: "warn", localizado: "warn", ajuste: "neutral", resolvido: "ok" };

const dias = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
const aberto = (r: Registro) => r.status !== "resolvido" && !r.saiuEm;

export default function Bloqueios() {
  const [regs, setRegs] = useState<Record<string, Registro> | null>(null);
  const [planilhaEm, setPlanilhaEm] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState<Record<string, boolean>>({});
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);
  const [visao, setVisao] = useState<Visao>("abertos");
  const [q, setQ] = useState("");
  const [dep, setDep] = useState("");
  const [status, setStatus] = useState<"" | StatusTratativa>("");
  const [resp, setResp] = useState("");

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetch("/api/bloqueios", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha ao carregar");
      setRegs(Object.fromEntries((j.registros as Registro[]).map((x) => [x.id, x])));
      setPlanilhaEm(j.planilhaEm);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar");
    } finally {
      setCarregando(false);
    }
  }
  useEffect(() => {
    carregar();
  }, []);

  async function salvar(id: string, campos: Partial<Pick<Registro, "status" | "responsavel" | "obs">>) {
    if (!regs) return;
    const antes = regs[id];
    setRegs({ ...regs, [id]: { ...antes, ...campos } }); // otimista
    setSalvando((s) => ({ ...s, [id]: true }));
    setErroSalvar(null);
    try {
      const r = await fetch("/api/bloqueios", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, campos }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha ao salvar");
      setRegs((cur) => (cur ? { ...cur, [id]: j.registro } : cur));
    } catch (e) {
      setRegs((cur) => (cur ? { ...cur, [id]: antes } : cur)); // desfaz
      setErroSalvar(e instanceof Error ? e.message : "Falha ao salvar");
    } finally {
      setSalvando((s) => ({ ...s, [id]: false }));
    }
  }

  const todos = useMemo(() => (regs ? Object.values(regs) : []), [regs]);

  const lista = useMemo(() => {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    return todos
      .filter((r) => {
        if (visao === "abertos" && !aberto(r)) return false;
        if (visao === "saiu" && !(r.saiuEm && r.status !== "resolvido")) return false;
        if (visao === "resolvidos" && r.status !== "resolvido") return false;
        if (dep && r.dep !== dep) return false;
        if (status && r.status !== status) return false;
        if (resp && norm(r.responsavel) !== norm(resp)) return false;
        if (toks.length) {
          const h = norm(`${r.pi} ${r.desc} ${r.end} ${r.lote} ${r.id} ${r.responsavel} ${r.obs}`);
          if (!toks.every((t) => h.includes(t))) return false;
        }
        return true;
      })
      .sort((a, b) => a.primeiroVisto.localeCompare(b.primeiroVisto) || a.pi.localeCompare(b.pi));
  }, [todos, visao, q, dep, status, resp]);

  const resumo = useMemo(() => {
    const ab = todos.filter(aberto);
    const porStatus: Record<string, number> = {};
    for (const r of ab) porStatus[r.status] = (porStatus[r.status] ?? 0) + 1;
    return {
      abertos: ab.length,
      unidades: ab.reduce((s, r) => s + r.qtd, 0),
      pis: new Set(ab.map((r) => r.pi)).size,
      maisAntigo: ab.length ? Math.max(...ab.map((r) => dias(r.primeiroVisto))) : 0,
      porStatus,
      saiu: todos.filter((r) => r.saiuEm && r.status !== "resolvido").length,
      resolvidos: todos.filter((r) => r.status === "resolvido").length,
    };
  }, [todos]);

  const deps = useMemo(() => [...new Set(todos.map((r) => r.dep))].sort(), [todos]);
  const responsaveis = useMemo(() => [...new Set(todos.map((r) => r.responsavel.trim()).filter(Boolean))].sort(), [todos]);

  function exportar() {
    const cab = ["Dias no controle", "PI", "Descrição", "Depósito", "Área", "Endereço", "Quantidade", "Lote", "ID_QUANT", "Status", "Responsável", "Observação", "Saiu da planilha", "Atualizado em"];
    const corpo = lista.map((r) => [dias(r.primeiroVisto), r.pi, r.desc, r.dep, r.area, r.end, String(r.qtd).replace(".", ","), r.lote, r.id, NOME_STATUS[r.status], r.responsavel, r.obs, r.saiuEm ? fmtDataHora(r.saiuEm) : "", r.atualizadoEm ? fmtDataHora(r.atualizadoEm) : ""]);
    const blob = new Blob(["﻿" + csv([cab, ...corpo])], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bloqueios-nao-encontrado.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (erro)
    return (
      <div className="card err">
        <strong>Não foi possível carregar o controle de bloqueios.</strong>
        <p>{erro}</p>
        <button className="btn" onClick={carregar}>Tentar novamente</button>
      </div>
    );
  if (!regs) return <p className="muted">{carregando ? "Carregando bloqueios NAO ENCONTRADO…" : ""}</p>;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="bar" style={{ marginBottom: 0, justifyContent: "space-between" }}>
        <p className="muted small" style={{ margin: 0 }}>
          Bloqueios com motivo <strong>NAO ENCONTRADO</strong> da planilha de estoque de {fmtDataHora(planilhaEm)}. As tratativas são compartilhadas por todos que usam o app.
        </p>
        <button className="btn" onClick={carregar} disabled={carregando}>{carregando ? "Atualizando…" : "Recarregar"}</button>
      </div>
      {erroSalvar && <div className="card err">Não consegui salvar: {erroSalvar}</div>}

      <div className="grid g4">
        <div className="card kpi bad"><div className="v">{fmtNum(resumo.abertos)}</div><div className="l">Linhas em aberto ({fmtNum(resumo.pis)} PIs)</div></div>
        <div className="card kpi"><div className="v">{fmtNum(resumo.unidades)}</div><div className="l">Unidades bloqueadas em aberto</div></div>
        <div className="card kpi warn"><div className="v">{fmtNum(resumo.maisAntigo)} d</div><div className="l">Mais antigo no controle</div></div>
        <div className="card kpi ok"><div className="v">{fmtNum(resumo.saiu + resumo.resolvidos)}</div><div className="l">{fmtNum(resumo.resolvidos)} resolvidos · {fmtNum(resumo.saiu)} saíram da planilha</div></div>
      </div>

      <div className="card">
        <div className="chips" style={{ marginBottom: 10 }}>
          {STATUS_TRATATIVA.filter((s) => s.id !== "resolvido").map((s) => (
            <button key={s.id} className="chip" aria-pressed={status === s.id} onClick={() => setStatus(status === s.id ? "" : s.id)}>
              {s.nome}: {fmtNum(resumo.porStatus[s.id] ?? 0)}
            </button>
          ))}
        </div>
        <div className="bar" style={{ justifyContent: "space-between" }}>
          <div className="seg" role="group" aria-label="Visão">
            <button aria-pressed={visao === "abertos"} onClick={() => setVisao("abertos")}>Em aberto</button>
            <button aria-pressed={visao === "saiu"} onClick={() => setVisao("saiu")}>Saíram da planilha</button>
            <button aria-pressed={visao === "resolvidos"} onClick={() => setVisao("resolvidos")}>Resolvidos</button>
            <button aria-pressed={visao === "todos"} onClick={() => setVisao("todos")}>Todos</button>
          </div>
          <input type="search" placeholder="Buscar PI, nome, endereço, lote, obs…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240, flex: "1 1 240px" }} />
          <select value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Depósito">
            <option value="">Todos os depósitos</option>
            {deps.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={resp} onChange={(e) => setResp(e.target.value)} aria-label="Responsável">
            <option value="">Todos os responsáveis</option>
            {responsaveis.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
        </div>

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="n">Dias</th><th>PI</th><th>Descrição</th><th>Local</th><th className="n">Qtd</th><th>Lote</th>
                <th>Status</th><th>Responsável</th><th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((r) => (
                <tr key={r.id}>
                  <td className="n" title={`No controle desde ${fmtDataHora(r.primeiroVisto)}`}>{dias(r.primeiroVisto)}</td>
                  <td>{r.pi}</td>
                  <td className="wrapc">
                    {r.desc}
                    {r.saiuEm && <div><span className="tag ok">saiu da planilha em {fmtDataHora(r.saiuEm)}</span></div>}
                  </td>
                  <td title={NOME_DEPOSITO[r.dep]}>{r.dep} · {r.end || "—"}</td>
                  <td className="n">{fmtNum(r.qtd)}</td>
                  <td>{r.lote || "—"}</td>
                  <td>
                    <select value={r.status} onChange={(e) => salvar(r.id, { status: e.target.value as StatusTratativa })} aria-label={`Status do PI ${r.pi}`}
                      className={`tag ${TOM[r.status]}`} style={{ border: "1px solid var(--line)" }}>
                      {STATUS_TRATATIVA.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                    </select>
                  </td>
                  <td><CampoTexto valor={r.responsavel} largura={130} rotulo={`Responsável pelo PI ${r.pi}`} onSalvar={(v) => salvar(r.id, { responsavel: v })} /></td>
                  <td className="wrapc">
                    <CampoTexto valor={r.obs} largura={260} rotulo={`Observação do PI ${r.pi}`} onSalvar={(v) => salvar(r.id, { obs: v })} />
                    {salvando[r.id] && <span className="muted small"> salvando…</span>}
                    {r.atualizadoEm && !salvando[r.id] && <div className="muted small">atualizado {fmtDataHora(r.atualizadoEm)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lista.length === 0 && <p className="muted">Nenhuma linha neste filtro.</p>}
        <p className="muted small">
          “Dias” conta desde que a linha entrou neste controle (a planilha não traz a data do bloqueio). Quando uma linha deixa de aparecer como NAO ENCONTRADO na planilha,
          ela vai para “Saíram da planilha” — confira se foi tratada de fato e marque como Resolvido.
        </p>
      </div>
    </div>
  );
}

/** Campo que só grava ao sair do campo (ou Enter), e só se o texto mudou. */
function CampoTexto({ valor, largura, rotulo, onSalvar }: { valor: string; largura: number; rotulo: string; onSalvar: (v: string) => void }) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  const gravar = () => {
    if (v.trim() !== valor.trim()) onSalvar(v.trim());
  };
  return (
    <input
      type="text"
      value={v}
      maxLength={600}
      aria-label={rotulo}
      onChange={(e) => setV(e.target.value)}
      onBlur={gravar}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      style={{ width: largura, padding: "4px 7px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)" }}
    />
  );
}
