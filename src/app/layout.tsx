import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

/**
 * Manrope, 400 to 800, for everything the brand owns. The public /p/ pages
 * load their own seller's fonts and never read this variable.
 */
const manrope = Manrope({
  variable: "--font-manrope",
  weight: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
  display: "swap",
});

// No title or icon here: this layout is shared with the public /p/ pages,
// which set their own from the seller's brand. Ours live in (brand)/layout.tsx.
export const metadata: Metadata = {};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
