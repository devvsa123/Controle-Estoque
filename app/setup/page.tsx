"use client";

import { useEffect } from "react";
import { Campo, FormJson, TelaPublica } from "@/components/TelaPublica";

export default function Setup() {
  // depois de configurado, esta tela deixa de existir
  useEffect(() => {
    fetch("/api/setup", { cache: "no-store" }).then(async (r) => { if (r.ok && (await r.json()).configurado) window.location.href = "/login"; }).catch(() => undefined);
  }, []);
  return (
    <TelaPublica titulo="Configuração inicial" descricao="Crie o primeiro usuário administrador. Esta tela deixa de existir depois disso.">
      <FormJson url="/api/setup" botao="Criar administrador" depois={() => "/"}>
        <Campo rotulo="Nome" name="nome" required autoFocus />
        <Campo rotulo="Usuário (NIP, somente números)" name="login" inputMode="numeric" required />
        <Campo rotulo="Senha (mínimo 8 caracteres)" name="senha" type="password" autoComplete="new-password" required minLength={8} />
        <Campo rotulo="Confirmar senha" name="confirmar" type="password" autoComplete="new-password" required minLength={8} />
      </FormJson>
    </TelaPublica>
  );
}
