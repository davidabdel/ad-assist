import { notFound } from 'next/navigation';
import { Listicle } from '@/components/Listicle';
import type { PublicPage } from '@/lib/page-data';

/**
 * Design preview only — not part of the product, and 404s outside development.
 * It exists so the listicle layout can be judged before a database exists.
 *
 * The product, price and testimonials below are REAL: scraped from
 * allbirds.com.au by scanner/src/ingest.js. The persona framing and the reasons
 * are placeholder copy standing in for what the LLM stage will write, and they
 * are labelled as such so nobody mistakes this for generated output.
 */

const SAMPLE: PublicPage = {
  campaign_id: 'preview',
  persona_id: null,
  page_title: 'Preview — persona landing page',
  meta_description: null,
  topbar: 'Free shipping + 30-day wear test · Ends Sunday',
  headline:
    '11 Reasons Commuters Are Replacing Their Runners With Something They Can Wear Into the Office',
  subheadline:
    'Placeholder copy standing in for the persona stage. Product details and the quotes below are real, pulled from the live store by the ingest worker.',
  // Null on purpose: this preview renders in `preview` mode, so the empty
  // picture slots draw as labelled boxes. That is exactly what the operator
  // sees on the real base page while approving the words.
  hero_image_url: null,
  hero_image_alt: null,
  reasons: [
    { number: 1, title: 'They do not read as gym shoes', body: 'PLACEHOLDER — this is where the persona-specific reason lands. Reasons 1 to 3 are the part that swaps per persona; the remaining seven stay locked across all 20 pages.', image_prompt: 'The shoe worn with chinos in an office, not with activewear.' },
    { number: 2, title: 'No socks, no smell, no second pair in a bag', body: 'PLACEHOLDER — persona-specific reason two.', image_prompt: 'The shoe alone on a desk beside a laptop bag.' },
    { number: 3, title: 'Machine washable, so a wet platform is not a disaster', body: 'PLACEHOLDER — persona-specific reason three.', image_prompt: 'A pair going into a washing machine drum.' },
    { number: 4, title: 'Merino wool regulates temperature', body: 'LOCKED — shared across all 20 persona pages. Written once from the product brief.', image_prompt: 'Close crop on the wool upper showing the knit texture.' },
    { number: 5, title: 'Made from FSC-certified eucalyptus fibre', body: 'LOCKED — shared reason.', image_prompt: '' },
    { number: 6, title: 'Carbon footprint printed on every pair', body: 'LOCKED — shared reason.', image_prompt: 'The printed carbon figure on the shoe itself.' },
  ],
  testimonials: [
    { quote: 'Great shoes; degraded packaging! I have purchased seven pairs of All Birds shoes over the years; I love them! Comfortable, easy to keep clean, sustainable materials and just an all round fantastic shoe.', reviewer: 'Djmetz', rating: 4 },
    { quote: 'Great shoe! My son bought me a pair several years ago and I have worn them almost daily since.', reviewer: 'Verified buyer', rating: 5 },
  ],
  offer_headline: "Men's Tree Runner — $72 AUD",
  offer_body:
    'Real product and price, read from the live store by the ingest worker. The button points at the checkout URL entered when the campaign was created.',
  cta_button_text: 'Shop the Tree Runner',
  cta_url: 'https://www.allbirds.com.au/products/tree-runner-mens-navy-night-white-sole',
  // Null renders the neutral editorial theme, which is what this preview is
  // for: judging the layout itself rather than one seller's paint job.
  brand: null,
  // A physical product, so the page ends in a checkout link. Swap this to
  // 'vehicle' with a number beside it to see the tap-to-call and the enquiry
  // form instead — that is the whole of the difference in the renderer.
  product_type: 'ecom',
  contact_phone: null,
};

export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Listicle page={SAMPLE} preview />;
}
