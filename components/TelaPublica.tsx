"use client";

import { useState } from "react";

/** Moldura das telas sem login (entrar, configuração inicial, trocar senha), como no sistema de NF. */
export function TelaPublica({ titulo, descricao, children }: { titulo: string; descricao: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 380, display: "grid", gap: 12 }}>
        <div>
          <p className="muted small" style={{ margin: 0, textTransform: "uppercase", letterSpacing: ".04em" }}>Controle de Estoque · DepFMRJ</p>
          <h1 style={{ margin: "4px 0 0", fontSize: 22 }}>{titulo}</h1>
          <p className="muted small" style={{ margin: "4px 0 0" }}>{descricao}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Campo = ({ rotulo, ...p }: { rotulo: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <label className="small" style={{ display: "grid", gap: 4 }}>{rotulo}<input {...p} /></label>
);

/** Formulário que envia JSON para `url` e, dando certo, vai para `depois`. */
export function FormJson({ url, botao, depois, children }: { url: string; botao: string; depois: () => string; children: React.ReactNode }) {
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  async function enviar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEnviando(true);
    setErro("");
    try {
      const corpo = Object.fromEntries(new FormData(e.currentTarget).entries());
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || "Não foi possível concluir.");
      window.location.href = depois();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível concluir.");
      setEnviando(false);
    }
  }
  return (
    <form onSubmit={enviar} style={{ display: "grid", gap: 12 }}>
      {children}
      {erro && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>{erro}</p>}
      <button className="btn" type="submit" disabled={enviando} style={{ background: "var(--brand)", color: "#fff", borderColor: "var(--brand)" }}>
        {enviando ? "Aguarde…" : botao}
      </button>
    </form>
  );
}
