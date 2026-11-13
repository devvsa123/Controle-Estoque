"use client";

import { useEffect, useState } from "react";
import { fmtDataHora } from "@/lib/util";

interface Usuario { login: string; nome: string; papel: "admin" | "usuario"; ativo: boolean; criadoEm: string; criadoPor: string; ultimoAcesso: string | null }

/** Senha provisória fácil de ditar: 3 grupos de letras e números, sem caracteres parecidos (0/O, 1/l). */
function senhaProvisoria() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  const v = new Uint32Array(12);
  crypto.getRandomValues(v);
  const s = Array.from(v, (x) => c[x % c.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Cadastro de quem pode entrar no sistema (só administradores veem). */
export default function Usuarios() {
  const [lista, setLista] = useState<Usuario[] | null>(null);
  const [msg, setMsg] = useState<{ texto: string; erro: boolean } | null>(null);
  const [novo, setNovo] = useState({ nome: "", login: "", senha: senhaProvisoria(), papel: "usuario" as "admin" | "usuario" });
  const [ocupado, setOcupado] = useState(false);

  async function chamar(corpo?: Record<string, unknown>, sucesso?: string) {
    setOcupado(true);
    try {
      const r = await fetch("/api/usuarios", corpo ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) } : { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha");
      setLista(j.usuarios);
      if (sucesso) setMsg({ texto: sucesso, erro: false });
      return true;
    } catch (e) {
      setMsg({ texto: e instanceof Error ? e.message : "Falha", erro: true });
      return false;
    } finally {
      setOcupado(false);
    }
  }
  useEffect(() => { chamar(); }, []);

  async function criar(e: React.FormEvent) {
    e.preventDefault();
    const ok = await chamar({ acao: "criar", ...novo }, `Usuário "${novo.login}" criado. Passe para a pessoa: usuário ${novo.login} e senha ${novo.senha} — ela pode trocar a senha depois em "Trocar senha".`);
    if (ok) setNovo({ nome: "", login: "", senha: senhaProvisoria(), papel: "usuario" });
  }
  async function redefinir(u: Usuario) {
    const senha = senhaProvisoria();
    if (!confirm(`Redefinir a senha de ${u.nome}? A pessoa será desconectada e a nova senha será: ${senha}`)) return;
    await chamar({ acao: "senha", login: u.login, senha }, `Nova senha de ${u.login}: ${senha} — passe para a pessoa.`);
  }
  const acao = (u: Usuario, a: string, pergunta: string, extra: Record<string, unknown> = {}) => {
    if (confirm(pergunta)) chamar({ acao: a, login: u.login, ...extra }, "Alteração salva.");
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <form className="card" onSubmit={criar}>
        <h2>Cadastrar usuário</h2>
        <div className="bar" style={{ alignItems: "flex-end", marginBottom: 0 }}>
          <label className="small" style={{ display: "grid", gap: 4 }}>Nome (aparece no sistema)
            <input value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} placeholder="SG Fulano" required style={{ width: 200 }} />
          </label>
          <label className="small" style={{ display: "grid", gap: 4 }}>Usuário (para entrar)
            <input value={novo.login} onChange={(e) => setNovo({ ...novo, login: e.target.value.toLowerCase().replace(/\s+/g, ".") })} placeholder="fulano.silva" required pattern="[a-z0-9._\-]{3,40}" title="3 a 40 letras minúsculas, números, ponto, hífen ou sublinhado" style={{ width: 160 }} />
          </label>
          <label className="small" style={{ display: "grid", gap: 4 }}>Senha provisória
            <span style={{ display: "flex", gap: 4 }}>
              <input value={novo.senha} onChange={(e) => setNovo({ ...novo, senha: e.target.value })} minLength={8} required style={{ width: 150, fontFamily: "monospace" }} />
              <button type="button" className="btn" onClick={() => setNovo({ ...novo, senha: senhaProvisoria() })} title="Gerar outra">↻</button>
            </span>
          </label>
          <label className="small" style={{ display: "grid", gap: 4 }}>Perfil
            <select value={novo.papel} onChange={(e) => setNovo({ ...novo, papel: e.target.value as "admin" | "usuario" })}>
              <option value="usuario">Usuário</option>
              <option value="admin">Administrador (cadastra usuários)</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={ocupado} style={{ background: "var(--brand)", color: "#fff", borderColor: "var(--brand)" }}>Cadastrar</button>
        </div>
      </form>

      {msg && <div className={msg.erro ? "card err" : "note"} style={msg.erro ? undefined : { background: "var(--ok-soft)", color: "var(--ok)" }}>{msg.texto}</div>}

      <div className="card">
        <h2>Usuários ({lista?.length ?? "…"})</h2>
        {!lista ? <p className="muted small">Carregando…</p> : lista.length === 0 ? <p className="muted small">Nenhum usuário cadastrado ainda.</p> : (
          <div style={{ overflow: "auto" }}>
            <table>
              <thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Situação</th><th>Último acesso</th><th>Cadastrado</th><th></th></tr></thead>
              <tbody>
                {lista.map((u) => (
                  <tr key={u.login} style={u.ativo ? undefined : { opacity: 0.55 }}>
                    <td>{u.nome}</td>
                    <td><code>{u.login}</code></td>
                    <td>{u.papel === "admin" ? <span className="tag neutral">Administrador</span> : "Usuário"}</td>
                    <td>{u.ativo ? <span className="tag ok">ativo</span> : <span className="tag bad">desativado</span>}</td>
                    <td className="small">{u.ultimoAcesso ? fmtDataHora(u.ultimoAcesso) : "nunca"}</td>
                    <td className="small">{fmtDataHora(u.criadoEm)} por {u.criadoPor}</td>
                    <td style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button className="btn small" disabled={ocupado} onClick={() => redefinir(u)}>Redefinir senha</button>
                      {u.ativo
                        ? <button className="btn small" disabled={ocupado} onClick={() => acao(u, "desativar", `Desativar ${u.nome}? A pessoa perde o acesso na hora.`)}>Desativar</button>
                        : <button className="btn small" disabled={ocupado} onClick={() => acao(u, "ativar", `Reativar ${u.nome}?`)}>Reativar</button>}
                      <button className="btn small" disabled={ocupado} onClick={() => acao(u, "papel", u.papel === "admin" ? `Tirar ${u.nome} de administrador?` : `Tornar ${u.nome} administrador?`, { papel: u.papel === "admin" ? "usuario" : "admin" })}>
                        {u.papel === "admin" ? "Tirar admin" : "Tornar admin"}
                      </button>
                      <button className="btn small" disabled={ocupado} onClick={() => acao(u, "remover", `Apagar ${u.nome} de vez?`)} style={{ color: "var(--bad)" }}>Apagar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Nome do usuário, "Trocar senha" e "Sair", no canto do menu. */
export function MenuUsuario({ usuario }: { usuario: { nome: string; papel: string } | null }) {
  const [trocando, setTrocando] = useState(false);
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [msg, setMsg] = useState("");

  async function sair() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }
  async function trocar(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/sessao", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ atual, nova }) });
    const j = await r.json();
    if (!r.ok) return setMsg(j.erro || "Falha");
    setMsg("Senha trocada.");
    setAtual(""); setNova("");
    setTimeout(() => { setTrocando(false); setMsg(""); }, 1500);
  }

  if (!usuario) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto", position: "relative" }} className="small">
      <span className="muted">{usuario.nome}</span>
      <button className="btn small" onClick={() => setTrocando(!trocando)}>Trocar senha</button>
      <button className="btn small" onClick={sair}>Sair</button>
      {trocando && (
        <form className="card" onSubmit={trocar} style={{ position: "absolute", right: 0, top: "110%", zIndex: 20, display: "grid", gap: 8, width: 260 }}>
          <input type="password" placeholder="Senha atual" autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} required />
          <input type="password" placeholder="Nova senha (mínimo 8)" autoComplete="new-password" minLength={8} value={nova} onChange={(e) => setNova(e.target.value)} required />
          {msg && <span style={{ color: msg === "Senha trocada." ? "var(--ok)" : "var(--bad)" }}>{msg}</span>}
          <button className="btn" type="submit">Salvar nova senha</button>
        </form>
      )}
    </div>
  );
}
