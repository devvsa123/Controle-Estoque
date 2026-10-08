import { gzipSync } from "zlib";

/** Resposta JSON já comprimida: evita estourar o limite de ~4,5 MB de corpo das funções da Vercel. */
export function jsonGzip(corpo: unknown, status = 200): Response {
  const buf = gzipSync(Buffer.from(JSON.stringify(corpo)), { level: 6 });
  return new Response(new Uint8Array(buf), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Cache-Control": "no-store",
    },
  });
}
