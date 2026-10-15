import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Controle de Estoque",
  description: "Visualização e filtragem do estoque de fardamentos e insumos",
};

const hora = process.env.NEXT_PUBLIC_BUILD_TIME
  ? new Date(process.env.NEXT_PUBLIC_BUILD_TIME).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" })
  : "";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <div className="versao" title={process.env.NEXT_PUBLIC_BUILD_MSG || undefined}>
          v{process.env.NEXT_PUBLIC_BUILD_SHA || "dev"}{hora ? ` · ${hora}` : ""}
        </div>
      </body>
    </html>
  );
}
