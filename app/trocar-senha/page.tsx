"use client";

import { useEffect, useState } from "react";
import { Campo, FormJson, TelaPublica } from "@/components/TelaPublica";

export default function TrocarSenha() {
  const [eu, setEu] = useState<{ nome: string; deveTrocarSenha: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/sessao", { cache: "no-store" }).then(async (r) => (r.status === 401 ? (window.location.href = "/login") : r.ok && setEu(await r.json()))).catch(() => undefined);
  }, []);
  return (
    <TelaPublica titulo="Trocar senha" descricao={eu?.deveTrocarSenha ? "Por segurança, defina uma nova senha antes de continuar." : eu ? `Usuário: ${eu.nome}` : ""}>
      <FormJson url="/api/sessao" botao="Salvar nova senha" depois={() => "/"}>
        <Campo rotulo="Senha atual" name="atual" type="password" autoComplete="current-password" required />
        <Campo rotulo="Nova senha (mínimo 8 caracteres)" name="nova" type="password" autoComplete="new-password" required minLength={8} />
        <Campo rotulo="Confirmar nova senha" name="confirmar" type="password" autoComplete="new-password" required minLength={8} />
      </FormJson>
      {eu && !eu.deveTrocarSenha && <p className="small" style={{ textAlign: "center", margin: 0 }}><a href="/">Cancelar</a></p>}
      {eu?.deveTrocarSenha && (
        <p className="small" style={{ textAlign: "center", margin: 0 }}>
          <a href="#" onClick={async (e) => { e.preventDefault(); await fetch("/api/logout", { method: "POST" }); window.location.href = "/login"; }}>Sair</a>
        </p>
      )}
    </TelaPublica>
  );
}
