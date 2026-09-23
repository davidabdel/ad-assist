/**
 * Proof that a persona page names itself on the click that leaves it, and that
 * it cannot break the links it is not meant to touch.
 *
 * The risk here is not that attribution fails — that shows up as a blank column
 * and someone goes looking. The risk is the other direction: a CTA rewriter
 * that quietly mangles a `tel:` link kills every enquiry on a vehicle campaign
 * and nothing anywhere says so. So most of this checks what it LEAVES ALONE.
 *
 * Pure. No database, no network, no build. It bills nothing.
 *
 *   node scripts/cta-url-check.mjs
 */
import { readFileSync } from 'node:fs';

// The module is TypeScript and this is a plain node script, so the one type
// annotation is stripped rather than dragging a compiler in for four lines.
const src = readFileSync(new URL('../src/lib/cta-url.ts', import.meta.url), 'utf8')
  .replace(/export function ctaHrefFor\([^)]*\): string/, 'function ctaHrefFor(ctaUrl, personaSlug)')
  .replace(/let url: URL;/, 'let url;');
const ctaHrefFor = new Function(`${src}; return ctaHrefFor;`)();

let failures = 0;
function check(name, actual, wanted) {
  const ok = actual === wanted;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got:    ${actual}\n         wanted: ${wanted}`}`);
  if (!ok) failures += 1;
}

const EBOOK = 'https://ai-ebook.uconnect.com.au/?buy=1';

console.log('\nwhat it adds');
check(
  'the persona slug rides the click as ?src=',
  ctaHrefFor(EBOOK, 'time-poor-owner'),
  'https://ai-ebook.uconnect.com.au/?buy=1&src=time-poor-owner',
);
check(
  'the checkout-opening parameter survives beside it',
  new URL(ctaHrefFor(EBOOK, 'time-poor-owner')).searchParams.get('buy'),
  '1',
);
check(
  'a destination with no query string gets a clean one',
  ctaHrefFor('https://pointtaken.cc/app', 'busy-founder'),
  'https://pointtaken.cc/app?src=busy-founder',
);
check(
  'a path with a deep URL keeps every segment',
  ctaHrefFor('https://buzzcleaning.com.au/product-details/product/buzz-starter-kit', 'first-time-buyer'),
  'https://buzzcleaning.com.au/product-details/product/buzz-starter-kit?src=first-time-buyer',
);

console.log('\nwhat it refuses to touch');
check(
  'a tap-to-call is left exactly alone',
  ctaHrefFor('tel:+61400000000', 'tradie-on-site'),
  'tel:+61400000000',
);
check(
  'the enquiry-form fallback is left exactly alone',
  ctaHrefFor('#enquire', 'tradie-on-site'),
  '#enquire',
);
check(
  'the base page, which has no persona, goes out unchanged',
  ctaHrefFor(EBOOK, null),
  EBOOK,
);
check(
  'so does a page whose persona slug is empty',
  ctaHrefFor(EBOOK, ''),
  EBOOK,
);
check(
  'an operator who wrote their own ?src= keeps it',
  ctaHrefFor('https://ai-ebook.uconnect.com.au/?buy=1&src=hand-written', 'time-poor-owner'),
  'https://ai-ebook.uconnect.com.au/?buy=1&src=hand-written',
);
check(
  'an unparseable checkout URL is handed back, not mangled',
  ctaHrefFor('https://', 'time-poor-owner'),
  'https://',
);

console.log('\nwhat it does not let through');
check(
  'a slug with a query-breaking character is encoded, not injected',
  new URL(ctaHrefFor(EBOOK, 'a&utm_source=evil')).searchParams.get('src'),
  'a&utm_source=evil',
);
check(
  'and that injection does not become a second parameter',
  new URL(ctaHrefFor(EBOOK, 'a&utm_source=evil')).searchParams.get('utm_source'),
  null,
);

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
