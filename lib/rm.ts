import * as XLSX from "xlsx";

/** Dados compactos das linhas de pedido (RM), em vetores paralelos para reduzir o tamanho do JSON. */
export interface RmDados {
  atualizadoEm: string | null;
  fonte: "blob" | "local";
  arquivo: string;
  colunas: string[]; // cabeçalhos encontrados (para diagnóstico)
  faltando: string[]; // colunas obrigatórias que não foram achadas
  resumo: { lidas: number; canceladas: number; semQtd: number; semCxp: number; semData: number; validas: number; pisTotal: number; pisComLinhaSemCxp: number };
  pis: [string, string][]; // [PI, nomenclatura]
  rms: number; // nº de RMs distintas entre as linhas válidas
  p: number[]; // índice em `pis`
  r: number[]; // índice da RM
  d: number[]; // dia (dias desde 1970-01-01) da DATA_ENTRADA
  q: number[]; // QTD do pedido
  c: number[]; // CXP: quantidade padrão por caixa
}

const ALIAS: Record<string, string[]> = {
  pedido: ["PEDIDO", "RM", "NUM_PEDIDO"],
  pi: ["PI"],
  desc: ["NOMENCLATURA", "DESCRICAO"],
  status: ["STATUS"],
  entrada: ["DATA_ENTRADA", "ENTRADA", "DT_ENTRADA"],
  qtd: ["QTD", "QTDE", "QUANTIDADE", "QTD_PEDIDO", "QTD_PEDIDA"],
  cxp: ["CXP", "CX_PADRAO", "CAIXA_PADRAO", "QTD_CAIXA", "QTD_POR_CAIXA", "QTD_CX"],
};
const OBRIGATORIAS = ["pedido", "pi", "entrada", "qtd", "cxp"];

function normCab(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").trim().replace(/\./g, "").replace(",", ".").replace(/[^\d.\-]/g, ""));
  // "1.000" (milhar) vira 1000; "12,5" vira 12.5. Valores simples sem separador passam direto.
  return Number.isFinite(n) ? n : NaN;
}

function numSimples(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  // formato brasileiro com vírgula decimal
  if (/,/.test(s)) return num(s);
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** "dd/mm/aaaa hh:mm:ss" (texto) ou serial do Excel -> dias desde 1970-01-01. NaN se inválida. */
function dia(v: unknown): number {
  if (typeof v === "number") return Math.floor(v - 25569);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v ?? "").trim());
  if (!m) return NaN;
  const t = Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return Number.isFinite(t) ? Math.floor(t / 86400000) : NaN;
}

function chavePi(v: unknown): string {
  let s = typeof v === "number" ? String(Math.round(v)) : String(v ?? "").trim();
  if (/^\d+$/.test(s) && s.length < 9) s = s.padStart(9, "0");
  return s;
}

export function lerPedidos(buf: Buffer, meta: Pick<RmDados, "atualizadoEm" | "fonte" | "arquivo">): RmDados {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
  const vazio: RmDados = {
    ...meta,
    colunas: [],
    faltando: [],
    resumo: { lidas: 0, canceladas: 0, semQtd: 0, semCxp: 0, semData: 0, validas: 0, pisTotal: 0, pisComLinhaSemCxp: 0 },
    pis: [], rms: 0, p: [], r: [], d: [], q: [], c: [],
  };
  if (!aoa.length) return vazio;

  const cab = (aoa[0] as unknown[]).map(normCab);
  vazio.colunas = (aoa[0] as unknown[]).map((c) => String(c ?? "").trim()).filter(Boolean);
  const idx: Record<string, number> = {};
  for (const [campo, nomes] of Object.entries(ALIAS)) {
    const i = cab.findIndex((c) => nomes.includes(c));
    if (i >= 0) idx[campo] = i;
  }
  vazio.faltando = OBRIGATORIAS.filter((c) => idx[c] === undefined).map((c) => ALIAS[c][0]);
  if (vazio.faltando.length) return vazio;

  const pisIdx = new Map<string, number>();
  const rmIdx = new Map<string, number>();
  const pisTodos = new Set<string>();
  const pisSemCxp = new Set<string>();
  const out = vazio;
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    const pedido = String(row[idx.pedido] ?? "").trim();
    const pi = chavePi(row[idx.pi]);
    if (!pedido || !pi) continue;
    out.resumo.lidas++;
    if (idx.status !== undefined && String(row[idx.status] ?? "").trim().toUpperCase() === "CANCELADO") {
      out.resumo.canceladas++;
      continue;
    }
    const q = numSimples(row[idx.qtd]);
    if (!(q > 0)) { out.resumo.semQtd++; continue; }
    pisTodos.add(pi);
    const c = numSimples(row[idx.cxp]);
    if (!(c > 0)) { out.resumo.semCxp++; pisSemCxp.add(pi); continue; }
    const d = dia(row[idx.entrada]);
    if (!Number.isFinite(d)) { out.resumo.semData++; continue; }

    let pIdx = pisIdx.get(pi);
    if (pIdx === undefined) {
      pIdx = out.pis.length;
      pisIdx.set(pi, pIdx);
      out.pis.push([pi, idx.desc !== undefined ? String(row[idx.desc] ?? "").replace(/\s+/g, " ").trim() : ""]);
    }
    let rIdx = rmIdx.get(pedido);
    if (rIdx === undefined) {
      rIdx = rmIdx.size;
      rmIdx.set(pedido, rIdx);
    }
    out.p.push(pIdx); out.r.push(rIdx); out.d.push(d); out.q.push(q); out.c.push(c);
    out.resumo.validas++;
  }
  out.rms = rmIdx.size;
  out.resumo.pisTotal = pisTodos.size;
  out.resumo.pisComLinhaSemCxp = pisSemCxp.size;
  return out;
}
