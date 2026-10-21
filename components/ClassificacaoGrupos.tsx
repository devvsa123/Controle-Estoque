"use client";

import { useMemo, useState } from "react";
import { COR_OUTROS, coresDosGrupos, grupoPadrao, normGrupo, type Classificacao } from "@/lib/grupos";
import type { Dados } from "@/lib/types";
import { cmpVariante, fmtNum, norm } from "@/lib/util";

interface Familia { nome: string; pis: Set<string>; variantes: Set<string>; locs: Set<string> }

/**
 * Edição da classificação usada no mapa: cada família (descrição sem o tamanho) pertence a um grupo.
 * As mudanças ficam em rascunho até salvar; salvar grava só as diferenças no JSON compartilhado.
 */
export function ClassificacaoGrupos({ estoque, classif, onSalvo }: { estoque: Dados; classif: Classificacao | null; onSalvo: (c: Classificacao) => void }) {
  const [rascunho, setRascunho] = useState<Record<string, string | null>>({});
  const [rascunhoCores, setRascunhoCores] = useState<Record<string, string | null>>({});
  const [busca, setBusca] = useState("");
  const [filtroGrupo, setFiltroGrupo] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [destino, setDestino] = useState("");
  const [qtdVisivel, setQtdVisivel] = useState(200);
  const [estado, setEstado] = useState<{ salvando: boolean; msg: string; erro: boolean }>({ salvando: false, msg: "", erro: false });

  const familias = useMemo(() => {
    const m = new Map<string, Familia>();
    for (const l of estoque.linhas) {
      if (estoque.escopos[l.dep] !== "estoque" || !(l.total > 0 || l.disp > 0)) continue;
      const p = estoque.produtos[l.pi];
      const nome = p?.familia ?? l.pi;
      const f = m.get(nome) ?? m.set(nome, { nome, pis: new Set(), variantes: new Set(), locs: new Set() }).get(nome)!;
      f.pis.add(l.pi);
      if (p?.variante) f.variantes.add(p.variante);
      f.locs.add(`${l.dep}|${l.end}`);
    }
    return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }, [estoque]);

  // classificação com o rascunho aplicado (é o que o mapa vai mostrar depois de salvar)
  const efetiva = useMemo<Classificacao>(() => {
    const base = classif ?? { versao: 1 as const, familias: {}, cores: {}, atualizadoEm: null };
    const fam = { ...base.familias };
    for (const [f, g] of Object.entries(rascunho)) if (g) fam[f] = g; else delete fam[f];
    const cores = { ...base.cores };
    for (const [g, c] of Object.entries(rascunhoCores)) if (c) cores[g] = c; else delete cores[g];
    return { ...base, familias: fam, cores };
  }, [classif, rascunho, rascunhoCores]);
  const grupoDe = (f: string) => efetiva.familias[f] ?? grupoPadrao(f);
  const cores = useMemo(() => coresDosGrupos(estoque, efetiva), [estoque, efetiva]);

  const grupos = useMemo(() => {
    const m = new Map<string, { nome: string; familias: number; pis: number; locs: Set<string> }>();
    for (const f of familias) {
      const g = efetiva.familias[f.nome] ?? grupoPadrao(f.nome);
      const x = m.get(g) ?? m.set(g, { nome: g, familias: 0, pis: 0, locs: new Set() }).get(g)!;
      x.familias++;
      x.pis += f.pis.size;
      for (const l of f.locs) x.locs.add(l);
    }
    return [...m.values()].sort((a, b) => b.locs.size - a.locs.size || a.nome.localeCompare(b.nome));
  }, [familias, efetiva]);

  const alteracoes = Object.keys(rascunho).length + Object.keys(rascunhoCores).length;

  const mover = (nomes: Iterable<string>, grupo: string) => {
    const g = normGrupo(grupo);
    if (!g) return;
    setRascunho((r) => {
      const n = { ...r };
      for (const f of nomes) {
        const salvo = classif?.familias[f] ?? null;
        const novo = g === grupoPadrao(f) ? null : g;
        if (novo === salvo) delete n[f]; // voltou ao que já está salvo
        else n[f] = novo;
      }
      return n;
    });
  };
  const mudarCor = (g: string, cor: string | null) => {
    setRascunhoCores((r) => {
      const n = { ...r };
      if ((classif?.cores[g] ?? null) === cor) delete n[g];
      else n[g] = cor;
      return n;
    });
  };
  const renomear = (g: string) => {
    const novo = normGrupo(window.prompt(`Novo nome para o grupo ${g} (se já existir, os dois grupos são juntados):`, g) ?? "");
    if (!novo || novo === g) return;
    mover(familias.filter((f) => grupoDe(f.nome) === g).map((f) => f.nome), novo);
    if (efetiva.cores[g]) { mudarCor(novo, efetiva.cores[g]); mudarCor(g, null); }
    if (filtroGrupo === g) setFiltroGrupo(novo);
  };

  async function salvar() {
    setEstado({ salvando: true, msg: "", erro: false });
    try {
      const r = await fetch("/api/grupos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ familias: rascunho, cores: rascunhoCores }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha ao salvar");
      onSalvo(j);
      setRascunho({});
      setRascunhoCores({});
      setEstado({ salvando: false, msg: "Classificação salva. O mapa já usa os grupos novos.", erro: false });
    } catch (e) {
      setEstado({ salvando: false, msg: e instanceof Error ? e.message : "Falha ao salvar", erro: true });
    }
  }

  const toks = norm(busca).split(/\s+/).filter(Boolean);
  const visiveis = familias.filter((f) => {
    if (filtroGrupo && grupoDe(f.nome) !== filtroGrupo) return false;
    const h = norm(`${f.nome} ${grupoDe(f.nome)} ${[...f.pis].join(" ")}`);
    return toks.every((t) => h.includes(t));
  });
  const todasMarcadas = visiveis.length > 0 && visiveis.every((f) => sel.has(f.nome));

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>
          Cada <strong>família</strong> (a descrição sem o tamanho, como na aba Estoque) pertence a um <strong>grupo</strong>. O mapa pinta as LOCs pelo grupo e, ao clicar num grupo, pelas famílias dele.
          Sem ajuste, o grupo é a primeira palavra da descrição. Junte grupos parecidos (ex.: CALCA e BERMUDA em “CALÇAS E BERMUDAS”) para o mapa ficar com poucas cores.
          As 8 cores vão para os grupos que mais ocupam LOCs; os demais ficam cinza, a não ser que você escolha uma cor.
        </p>
        <div className="bar" style={{ marginBottom: 0 }}>
          <button className="btn" onClick={salvar} disabled={!alteracoes || estado.salvando} style={alteracoes ? { borderColor: "var(--brand)", color: "var(--brand)", fontWeight: 600 } : undefined}>
            {estado.salvando ? "Salvando…" : `Salvar${alteracoes ? ` (${fmtNum(alteracoes)} alterações)` : ""}`}
          </button>
          <button className="btn" onClick={() => { setRascunho({}); setRascunhoCores({}); }} disabled={!alteracoes || estado.salvando}>Descartar alterações</button>
          <span className="small muted">{fmtNum(grupos.length)} grupos · {fmtNum(familias.length)} famílias · {classif?.atualizadoEm ? `última gravação ${new Date(classif.atualizadoEm).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "nenhum ajuste salvo ainda"}</span>
          {estado.msg && <span className="small" style={{ color: estado.erro ? "var(--bad)" : "var(--ok)" }}>{estado.msg}</span>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="card" style={{ flex: "1 1 380px", minWidth: 300 }}>
          <h2>Grupos</h2>
          <p className="small muted" style={{ marginTop: 0 }}>Clique no nome para ver as famílias do grupo. “Renomear” para um nome que já existe junta os dois grupos.</p>
          <div style={{ maxHeight: 620, overflow: "auto" }}>
            <table>
              <thead><tr><th>Cor</th><th>Grupo</th><th className="n">Famílias</th><th className="n">PIs</th><th className="n">LOCs</th><th></th></tr></thead>
              <tbody>
                {grupos.map((g) => {
                  const cor = cores.get(g.nome) ?? COR_OUTROS;
                  return (
                    <tr key={g.nome} style={filtroGrupo === g.nome ? { background: "var(--brand-soft)" } : undefined}>
                      <td>
                        <input type="color" value={cor} onChange={(e) => mudarCor(g.nome, e.target.value)} aria-label={`Cor do grupo ${g.nome}`} style={{ width: 28, height: 20, padding: 0, border: 0, background: "none" }} />
                        {efetiva.cores[g.nome] && <button className="chip" title="Voltar à cor automática" onClick={() => mudarCor(g.nome, null)} style={{ marginLeft: 2 }}>auto</button>}
                      </td>
                      <td><button className="chip" onClick={() => setFiltroGrupo(filtroGrupo === g.nome ? "" : g.nome)}>{g.nome}</button></td>
                      <td className="n">{fmtNum(g.familias)}</td><td className="n">{fmtNum(g.pis)}</td><td className="n">{fmtNum(g.locs.size)}</td>
                      <td><button className="btn small" onClick={() => renomear(g.nome)}>Renomear</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ flex: "2 1 560px", minWidth: 320 }}>
          <h2>Famílias {filtroGrupo && <>do grupo {filtroGrupo} <button className="chip" onClick={() => setFiltroGrupo("")}>ver todas</button></>}</h2>
          <div className="bar">
            <input type="search" placeholder="Buscar família, grupo ou PI…" value={busca} onChange={(e) => { setBusca(e.target.value); setQtdVisivel(200); }} style={{ flex: "1 1 220px" }} />
            <span className="small muted">{fmtNum(sel.size)} marcadas →</span>
            <input list="lista-grupos" placeholder="grupo de destino" value={destino} onChange={(e) => setDestino(e.target.value)} style={{ width: 200 }} />
            <button className="btn" disabled={!sel.size || !normGrupo(destino)} onClick={() => { mover(sel, destino); setSel(new Set()); }}>Mover marcadas</button>
          </div>
          <datalist id="lista-grupos">{grupos.map((g) => <option key={g.nome} value={g.nome} />)}</datalist>
          <div style={{ maxHeight: 620, overflow: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" checked={todasMarcadas} aria-label="Marcar todas as visíveis" onChange={() => setSel((s) => { const n = new Set(s); for (const f of visiveis) if (todasMarcadas) n.delete(f.nome); else n.add(f.nome); return n; })} /></th>
                  <th>Família</th><th>Tamanhos</th><th className="n">PIs</th><th className="n">LOCs</th><th>Grupo</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.slice(0, qtdVisivel).map((f) => {
                  const g = grupoDe(f.nome);
                  const mudou = f.nome in rascunho;
                  return (
                    <tr key={f.nome}>
                      <td><input type="checkbox" checked={sel.has(f.nome)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(f.nome)) n.delete(f.nome); else n.add(f.nome); return n; })} aria-label={`Marcar ${f.nome}`} /></td>
                      <td className="wrapc">{f.nome}</td>
                      <td className="small muted wrapc" style={{ minWidth: 120 }}>{[...f.variantes].sort(cmpVariante).join(", ")}</td>
                      <td className="n">{fmtNum(f.pis.size)}</td><td className="n">{fmtNum(f.locs.size)}</td>
                      <td>
                        <span style={{ width: 10, height: 10, background: cores.get(g) ?? COR_OUTROS, display: "inline-block", marginRight: 6, border: "1px solid #cbd5e1" }} />
                        <input key={g} list="lista-grupos" defaultValue={g} aria-label={`Grupo de ${f.nome}`} style={{ width: 170, fontWeight: mudou ? 700 : undefined }}
                          onBlur={(e) => { if (normGrupo(e.target.value) && normGrupo(e.target.value) !== g) mover([f.nome], e.target.value); }}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                        {g !== grupoPadrao(f.nome) && <span className="tag neutral" style={{ marginLeft: 4 }} title={`Padrão: ${grupoPadrao(f.nome)}`}>ajustado</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visiveis.length > qtdVisivel && <button className="btn" style={{ marginTop: 8 }} onClick={() => setQtdVisivel(qtdVisivel + 300)}>Mostrar mais ({fmtNum(visiveis.length - qtdVisivel)} restantes)</button>}
            {visiveis.length === 0 && <p className="muted small">Nenhuma família encontrada.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
