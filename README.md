# Controle de Estoque

Visualização e filtragem rápida do estoque a partir da planilha `Estoque_Detalhado` extraída do banco.

## Como funciona

- A planilha é lida do **Vercel Blob** com o nome fixo `controle-estoque.xlsx` (store privado ou público).
- Para atualizar os dados, substitua esse arquivo no Blob (mesmo nome) e clique em **Recarregar** no app.
- Regras de negócio ficam em `lib/config.ts` (quais depósitos contam como estoque, recebimento ou fora do controle).

| Escopo | Depósitos |
| --- | --- |
| Estoque | P01, P02, P03, P04, P05, P06 |
| Recebimento (separado) | REC, P07 |
| Fora do controle (só consulta) | AQB, CLI, EST, EXP, INV, P08, P33 |

- Quantidade usada: coluna `DISPONIVEL`. **Livre** = `STATUS` LIVRE; **Bloqueado** = `STATUS` BLOQUEADO, detalhado por `MOTIVO`.
- Agrupamento por família (grade de tamanhos): `lib/parse.ts` (`separarFamilia`).

## Deploy na Vercel

1. Importe o repositório na Vercel (Next.js, sem configuração extra).
2. Em **Storage**, crie/conecte um **Blob store** ao projeto (cria `BLOB_READ_WRITE_TOKEN`).
3. Envie a planilha ao Blob com o nome exato `controle-estoque.xlsx`.

## Desenvolvimento local

```bash
npm install
cp /caminho/Estoque_Detalhado.xlsx data/controle-estoque.xlsx   # ignorado pelo git
npm run dev
```

Sem `BLOB_READ_WRITE_TOKEN`, o app lê `data/controle-estoque.xlsx`.
