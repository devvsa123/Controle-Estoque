import type { Dados } from "./types";

/**
 * Classificação dos PIs em grupos para o mapa do paiol.
 * Família = descrição sem o tamanho (vem da planilha). Grupo = conjunto de famílias, editável na aba de classificação.
 * Sem classificação manual, o grupo é a 1ª palavra da família (CALCA, CAMISA, SAPATO…).
 */
export interface Classificacao {
  versao: 1;
  familias: Record<string, string>; // família -> grupo (só as que fogem do padrão)
  cores: Record<string, string>; // grupo -> cor escolhida (#rrggbb)
  atualizadoEm: string | null;
}

export const classificacaoVazia = (): Classificacao => ({ versao: 1, familias: {}, cores: {}, atualizadoEm: null });

export const normGrupo = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase().slice(0, 60);

export function grupoPadrao(familia: string): string {
  const p = familia.trim().split(/\s+/)[0] ?? "";
  return p.replace(/^[^A-Z0-9À-Ú]+|[^A-Z0-9À-Ú]+$/gi, "").toUpperCase() || "SEM GRUPO";
}

export const grupoDaFamilia = (c: Classificacao | null, familia: string) => c?.familias[familia] ?? grupoPadrao(familia);

/** Cores categóricas em ordem fixa (validadas para daltonismo); grupo além da 8ª cor fica em "Outros". */
export const PALETA = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const COR_OUTROS = "#c3c2b7";

/**
 * Cor de cada grupo: a escolhida na classificação ou, para os demais, as 8 cores da paleta na ordem dos grupos
 * que mais ocupam LOCs no estoque inteiro (não por paiol, para a cor não mudar ao trocar de paiol).
 */
export function coresDosGrupos(d: Dados, c: Classificacao | null): Map<string, string> {
  const locs = new Map<string, Set<string>>();
  for (const l of d.linhas) {
    if (d.escopos[l.dep] !== "estoque" || !(l.total > 0 || l.disp > 0)) continue;
    const g = grupoDaFamilia(c, d.produtos[l.pi]?.familia ?? l.pi);
    (locs.get(g) ?? locs.set(g, new Set()).get(g)!).add(`${l.dep}|${l.end}`);
  }
  const cores = new Map<string, string>();
  for (const [g, cor] of Object.entries(c?.cores ?? {})) cores.set(g, cor);
  const usadas = new Set(cores.values());
  const livres = PALETA.filter((p) => !usadas.has(p));
  const ordem = [...locs.entries()].filter(([g]) => !cores.has(g)).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  for (const [g] of ordem) cores.set(g, livres.shift() ?? COR_OUTROS);
  return cores;
}

/** Texto escuro ou claro conforme o fundo. */
export function tintaSobre(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? "#0f172a" : "#ffffff";
}
