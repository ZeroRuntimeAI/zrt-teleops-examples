import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import "../styles/global.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
/** Telemetry, code and keycaps. */
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "ZeroRuntime Studio",
  description: "A physics-simulated SO-101 arm in your browser, driven like a real teleop robot.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
