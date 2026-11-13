"use client";

import { useEffect } from "react";
import { Campo, FormJson, TelaPublica } from "@/components/TelaPublica";

/** Volta para onde a pessoa estava (só caminhos internos). */
const destino = () => {
  const v = new URLSearchParams(window.location.search).get("volta") ?? "/";
  return v.startsWith("/") && !v.startsWith("//") ? v : "/";
};

export default function Login() {
  // sem nenhum usuário cadastrado, o primeiro acesso é a configuração inicial
  useEffect(() => {
    fetch("/api/setup", { cache: "no-store" }).then(async (r) => { if (r.ok && !(await r.json()).configurado) window.location.href = "/setup"; }).catch(() => undefined);
  }, []);
  return (
    <TelaPublica titulo="Entrar" descricao="Use seu NIP e a sua senha.">
      <FormJson url="/api/login" botao="Entrar" depois={destino}>
        <Campo rotulo="Usuário (NIP)" name="usuario" inputMode="numeric" autoComplete="username" required autoFocus />
        <Campo rotulo="Senha" name="senha" type="password" autoComplete="current-password" required />
      </FormJson>
      <p className="muted small" style={{ textAlign: "center", margin: 0 }}>Esqueceu a senha? Procure o administrador do sistema.</p>
    </TelaPublica>
  );
}
