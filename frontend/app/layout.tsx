import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ICOMS — Milk Powder Classification",
  description: "Research platform for powder milk quality assessment",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
