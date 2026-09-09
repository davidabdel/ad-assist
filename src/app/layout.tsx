import type { Metadata } from "next";
import { Outfit, Manrope } from "next/font/google";
import "./globals.css";

/**
 * Outfit sets the headlines and every piece of chrome the brand owns; Manrope
 * carries the reading text. Both come from the design comp, and the weights
 * loaded are the ones it actually uses — Outfit's 300 is Paper's headline and
 * its 700 is Ink's, so both directions stay switchable from globals.css
 * without a font change.
 */
const outfit = Outfit({
  variable: "--font-outfit",
  weight: ["300", "400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ad Assist",
  description: "One thing to sell in, a landing page per buyer out.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${manrope.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
