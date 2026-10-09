/** Chave de ordenação pelo caminho físico do endereço: rua, coluna, nível, lado (12-01-01-AA). */
export function chaveRota(end: string): string {
  return end.split("-").map((p) => (/^\d+$/.test(p) ? p.padStart(4, "0") : p)).join("-");
}
