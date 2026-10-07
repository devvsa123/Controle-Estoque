export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function fmtNum(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

export function fmtData(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function fmtDataHora(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

const ORDEM_LETRAS = ["PP", "P", "M", "G", "GG", "XG", "EG", "XGG", "EGG", "EXG", "EXGG", "GGG"];

/** Ordena tamanhos: números em ordem numérica, letras na ordem de grade, depois o resto. */
export function cmpVariante(a: string, b: string): number {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return +a - +b;
  if (na) return -1;
  if (nb) return 1;
  const ia = ORDEM_LETRAS.indexOf(a), ib = ORDEM_LETRAS.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b, "pt-BR", { numeric: true });
}

export function diasAte(iso: string, hoje: Date): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000);
}

export function csv(linhas: (string | number)[][]): string {
  return linhas
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");
}
