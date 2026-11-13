"use client";

import { useEffect, useState } from "react";
import { fmtDataHora } from "@/lib/util";

interface Usuario {
  login: string; nome: string; papel: "admin" | "usuario"; ativo: boolean; deveTrocarSenha: boolean; bloqueado: boolean;
  criadoEm: string; criadoPor: string; ultimoAcesso: string | null;
}

/** Senha inicial fácil de ditar: 3 grupos de letras e números, sem caracteres parecidos (0/O, 1/l). */
function senhaInicial() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  const v = new Uint32Array(12);
  crypto.getRandomValues(v);
  const s = Array.from(v, (x) => c[x % c.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

const situacao = (u: Usuario) =>
  !u.ativo ? <span className="tag bad">Inativo</span>
  : u.bloqueado ? <span className="tag bad">Bloqueado (senhas erradas)</span>
  : u.deveTrocarSenha ? <span className="tag warn">Ativo · troca de senha pendente</span>
  : <span className="tag ok">Ativo</span>;

/** Cadastro de quem pode entrar no sistema (só administradores veem), no modelo do sistema de NF. */
export default function Usuarios() {
  const [lista, setLista] = useState<Usuario[] | null>(null);
  const [msg, setMsg] = useState<{ texto: string; erro: boolean } | null>(null);
  const novoVazio = () => ({ nome: "", login: "", senha: senhaInicial(), papel: "usuario" as "admin" | "usuario", deveTrocar: true });
  const [novo, setNovo] = useState(novoVazio);
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
    const ok = await chamar({ acao: "criar", ...novo },
      `Usuário cadastrado. Passe para ${novo.nome}: usuário ${novo.login.replace(/\D/g, "")} e senha ${novo.senha}${novo.deveTrocar ? " — ele vai definir uma senha própria no primeiro acesso." : "."}`);
    if (ok) setNovo(novoVazio());
  }
  async function redefinir(u: Usuario) {
    const senha = senhaInicial();
    if (!confirm(`Redefinir a senha de ${u.nome}?\n\nA nova senha inicial será: ${senha}\nA pessoa sai do sistema e terá de trocá-la no próximo acesso.`)) return;
    await chamar({ acao: "senha", login: u.login, senha, deveTrocar: true }, `Nova senha inicial de ${u.nome} (${u.login}): ${senha} — passe para a pessoa; ela troca no próximo acesso.`);
  }
  const acao = (u: Usuario, a: string, pergunta: string | null, extra: Record<string, unknown> = {}) => {
    if (!pergunta || confirm(pergunta)) chamar({ acao: a, login: u.login, ...extra }, "Alteração salva.");
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <form className="card" onSubmit={criar}>
        <h2>Cadastrar usuário</h2>
        <div className="bar" style={{ alignItems: "flex-end", marginBottom: 6 }}>
          <label className="small" style={{ display: "grid", gap: 4 }}>Nome
            <input value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} placeholder="SG Fulano" required style={{ width: 200 }} />
          </label>
          <label className="small" style={{ display: "grid", gap: 4 }}>Usuário (NIP, somente números)
            <input value={novo.login} onChange={(e) => setNovo({ ...novo, login: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" required pattern="\d{3,20}" title="NIP, somente números" style={{ width: 170 }} />
          </label>
          <label className="small" style={{ display: "grid", gap: 4 }}>Senha inicial
            <span style={{ display: "flex", gap: 4 }}>
              <input value={novo.senha} onChange={(e) => setNovo({ ...novo, senha: e.target.value })} minLength={8} required style={{ width: 150, fontFamily: "monospace" }} />
              <button type="button" className="btn" onClick={() => setNovo({ ...novo, senha: senhaInicial() })} title="Gerar outra">↻</button>
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
        <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={novo.deveTrocar} onChange={(e) => setNovo({ ...novo, deveTrocar: e.target.checked })} />
          Obrigar a trocar a senha no primeiro acesso
        </label>
      </form>

      {msg && <div className={msg.erro ? "card err" : "note"} style={msg.erro ? undefined : { background: "var(--ok-soft)", color: "var(--ok)" }}>{msg.texto}</div>}

      <div className="card">
        <h2>Usuários ({lista?.length ?? "…"})</h2>
        {!lista ? <p className="muted small">Carregando…</p> : lista.length === 0 ? <p className="muted small">Nenhum usuário cadastrado ainda.</p> : (
          <div style={{ overflow: "auto" }}>
            <table>
              <thead><tr><th>Nome</th><th>Usuário (NIP)</th><th>Perfil</th><th>Situação</th><th>Último acesso</th><th>Cadastrado</th><th></th></tr></thead>
              <tbody>
                {lista.map((u) => (
                  <tr key={u.login} style={u.ativo ? undefined : { opacity: 0.55 }}>
                    <td>{u.nome}</td>
                    <td><code>{u.login}</code></td>
                    <td>{u.papel === "admin" ? <span className="tag neutral">Administrador</span> : "Usuário"}</td>
                    <td>{situacao(u)}</td>
                    <td className="small">{u.ultimoAcesso ? fmtDataHora(u.ultimoAcesso) : "nunca"}</td>
                    <td className="small">{fmtDataHora(u.criadoEm)} · {u.criadoPor}</td>
                    <td style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button className="btn small" disabled={ocupado} onClick={() => redefinir(u)}>Redefinir senha</button>
                      {u.bloqueado && <button className="btn small" disabled={ocupado} onClick={() => acao(u, "desbloquear", null)}>Desbloquear</button>}
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
  async function sair() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }
  if (!usuario) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }} className="small">
      <span className="muted">{usuario.nome}</span>
      <a className="btn small" href="/trocar-senha" style={{ color: "inherit", textDecoration: "none" }}>Trocar senha</a>
      <button className="btn small" onClick={sair}>Sair</button>
    </div>
  );
}
