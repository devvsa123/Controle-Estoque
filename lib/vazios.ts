import * as XLSX from "xlsx";
import { DEPOSITOS_FORA_VAZIOS, ESCOPO_DEPOSITO } from "./config";
import type { Local } from "./missoes";

export interface Vazios {
  fr: Local[];
  sc: Local[];
  arquivo: string | null;
  atualizadoEm: string | null;
  erro: string | null;
}

export const SEM_VAZIOS: Vazios = { fr: [], sc: [], arquivo: null, atualizadoEm: null, erro: null };

const ENDERECO = /^\d{1,3}-\d{1,3}-\d{1,3}-(AA|BB)$/;

/**
 * Lê a "Consulta de endereços vazios" do WMS: ORT = paiol, BEREICH = área (FR/SC), PLATZ = endereço (12-01-01-AA).
 * Só entram paióis de estoque (P01, P02, P05); P03, P33, REC, P04, P07 e P06 ficam de fora.
 */
export function lerVazios(buf: Buffer): Pick<Vazios, "fr" | "sc"> {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  const fr: Local[] = [], sc: Local[] = [], vistos = new Set<string>();
  for (const r of linhas) {
    const dep = String(r.ORT ?? "").trim().toUpperCase();
    const area = String(r.BEREICH ?? "").trim().toUpperCase();
    if (!dep || DEPOSITOS_FORA_VAZIOS.includes(dep) || ESCOPO_DEPOSITO[dep] !== "estoque") continue;
    if (area !== "FR" && area !== "SC") continue;
    let end = String(r.PLATZ ?? "").trim().toUpperCase();
    const lado = String(r.PLATZ_4 ?? "").trim().toUpperCase();
    if (!ENDERECO.test(end) && /^\d{1,3}-\d{1,3}-\d{1,3}$/.test(end) && (lado === "AA" || lado === "BB")) end = `${end}-${lado}`;
    if (!ENDERECO.test(end)) continue;
    const k = dep + "|" + end;
    if (vistos.has(k)) continue;
    vistos.add(k);
    (area === "FR" ? fr : sc).push({ dep, end });
  }
  return { fr, sc };
}
