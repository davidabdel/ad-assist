import { Landing } from '@/components/Landing';

/**
 * The front door is a public page now: adtocart.cc sells itself here, and the
 * dashboard lives at /campaigns behind a login. Static on purpose — nothing on
 * it depends on who is looking.
 */
export const metadata = {
  title: "AdToCart — Your customers are unique. Why aren't your ads?",
  description: 'AdToCart turns one product page into twenty buyers, twenty landing pages and sixty ads, '
    + 'each one written for a different reason somebody would buy.',
};

export default function Page() {
  return <Landing />;
}
