import type { Metadata } from 'next';

/**
 * Everything adtocart.cc owns — the marketing page, login and the dashboard —
 * and nothing it does not. The public /p/ pages sit outside this group on
 * purpose, so a seller's landing page never wears our favicon.
 */
export const metadata: Metadata = {
  title: 'AdToCart',
  description: 'One product page in. Twenty buyers, twenty landing pages and sixty ads out.',
  icons: { icon: '/brand/adtocart-icon.png' },
};

export default function BrandLayout({ children }: LayoutProps<'/'>) {
  return children;
}
