import * as XLSX from "xlsx";
import type { Linha, Produto } from "./types";

const TAMANHOS_LETRA = new Set(["PP", "P", "M", "G", "GG", "XG", "XGG", "EG", "EGG", "EXG", "EXGG", "GGG", "U"]);

function txt(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(txt(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** yyyymmdd -> yyyy-mm-dd (vazio se inválida). */
function data(v: unknown): string {
  const s = txt(v).replace(/\.0+$/, "");
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return "";
  const [, y, mo, d] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return "";
  return `${y}-${mo}-${d}`;
}

/** Separa "CALCA BRANCA 44 (100%POL)" em família "CALCA BRANCA (100%POL)" e variante "44". */
export function separarFamilia(descricao: string): { familia: string; variante: string } {
  const desc = descricao.replace(/\s+/g, " ").trim();
  const toks = desc.split(" ");
  const primeiro = toks[0];

  // Insígnias/distintivos: o final é posto/graduação/especialidade (ex.: "CB-MR", "1SG-AM")
  if (primeiro === "INSIGNIA" && toks.length > 3) {
    return { familia: toks.slice(0, 3).join(" "), variante: toks.slice(3).join(" ") };
  }
  if (primeiro === "DISTINTIVO" && toks.length > 2) {
    return { familia: toks.slice(0, 2).join(" "), variante: toks.slice(2).join(" ") };
  }

  // Tamanho = número ou letra de tamanho, procurado de trás para frente
  for (let i = toks.length - 1; i >= 1; i--) {
    let t = toks[i];
    if (t === "TAM" || t === "TAM.") continue;
    const ehNumero = /^\d{1,2}$/.test(t);
    const ehLetra = TAMANHOS_LETRA.has(t);
    if (!ehNumero && !ehLetra) continue;
    // "TAM 48" -> remove também o "TAM"
    let ini = i;
    if (toks[i - 1] === "TAM" || toks[i - 1] === "TAM.") ini = i - 1;
    const familia = [...toks.slice(0, ini), ...toks.slice(i + 1)].join(" ");
    if (!familia) break;
    return { familia, variante: t };
  }
  return { familia: desc, variante: "" };
}

export function lerPlanilha(buf: Buffer | ArrayBuffer): { linhas: Linha[]; produtos: Record<string, Produto> } {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { raw: true, defval: "" });
  if (!rows.length) throw new Error("A planilha está vazia.");
  const obrigatorias = ["DEPOSITO", "PI", "DESCRICAO", "DISPONIVEL", "STATUS"];
  const faltando = obrigatorias.filter((c) => !(c in rows[0]));
  if (faltando.length) throw new Error(`Colunas não encontradas na planilha: ${faltando.join(", ")}`);

  const linhas: Linha[] = [];
  const produtos: Record<string, Produto> = {};
  for (const r of rows) {
    const pi = txt(r.PI);
    if (!pi) continue;
    if (!produtos[pi]) {
      const desc = txt(r.DESCRICAO).replace(/\s+/g, " ");
      const { familia, variante } = separarFamilia(desc);
      produtos[pi] = { desc, familia, variante };
    }
    const disp = num(r.DISPONIVEL);
    linhas.push({
      pi,
      dep: txt(r.DEPOSITO).toUpperCase(),
      area: txt(r.AREA).toUpperCase(),
      end: txt(r.ENDERECO),
      disp,
      total: r.TOTAL === "" ? disp : num(r.TOTAL),
      forn: txt(r.FORNECEDOR),
      lote: txt(r.LOTE),
      fab: data(r.FABRICACAO),
      val: data(r.VALIDADE),
      livre: txt(r.STATUS).toUpperCase() === "LIVRE",
      motivo: txt(r.MOTIVO),
      id: txt(r.ID_QUANT),
    });
  }
  return { linhas, produtos };
}
