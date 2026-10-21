import { atualizarJson, lerJson } from "./blobJson";
import { ARQUIVO_GRUPOS } from "./config";
import { classificacaoVazia, normGrupo, type Classificacao } from "./grupos";

export async function lerClassificacao(): Promise<Classificacao> {
  return (await lerJson(ARQUIVO_GRUPOS, classificacaoVazia)).dados;
}

/** Aplica só o que mudou (null = volta ao padrão), para duas pessoas editando ao mesmo tempo não se apagarem. */
export async function salvarClassificacao(familias: Record<string, string | null>, cores: Record<string, string | null>): Promise<Classificacao> {
  const ef = Object.entries(familias ?? {}).slice(0, 20000);
  const ec = Object.entries(cores ?? {}).slice(0, 2000);
  for (const [, cor] of ec) if (cor !== null && !/^#[0-9a-f]{6}$/i.test(cor)) throw new Error("Cor inválida");
  return atualizarJson(ARQUIVO_GRUPOS, classificacaoVazia, (c) => {
    for (const [fam, g] of ef) {
      const grupo = typeof g === "string" ? normGrupo(g) : "";
      if (grupo) c.familias[fam] = grupo;
      else delete c.familias[fam];
    }
    for (const [g, cor] of ec) {
      const grupo = normGrupo(g);
      if (!grupo) continue;
      if (cor) c.cores[grupo] = cor.toLowerCase();
      else delete c.cores[grupo];
    }
    c.atualizadoEm = new Date().toISOString();
    return ef.length > 0 || ec.length > 0;
  });
}
