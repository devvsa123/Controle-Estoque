"use client";

import { useState } from "react";

export default function Login() {
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [entrando, setEntrando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setEntrando(true);
    setErro("");
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario, senha }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Não foi possível entrar.");
      // volta para onde a pessoa estava (só caminhos internos)
      const volta = new URLSearchParams(window.location.search).get("volta") ?? "/";
      window.location.href = volta.startsWith("/") && !volta.startsWith("//") ? volta : "/";
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível entrar.");
      setEntrando(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <form className="card" onSubmit={entrar} style={{ width: "100%", maxWidth: 360, display: "grid", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Controle de Estoque</h1>
          <p className="muted small" style={{ margin: "4px 0 0" }}>Entre com o usuário e a senha que o administrador cadastrou.</p>
        </div>
        <label className="small" style={{ display: "grid", gap: 4 }}>
          Usuário
          <input autoFocus autoComplete="username" value={usuario} onChange={(e) => setUsuario(e.target.value)} required />
        </label>
        <label className="small" style={{ display: "grid", gap: 4 }}>
          Senha
          <input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required />
        </label>
        {erro && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>{erro}</p>}
        <button className="btn" type="submit" disabled={entrando} style={{ background: "var(--brand)", color: "#fff", borderColor: "var(--brand)" }}>
          {entrando ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
