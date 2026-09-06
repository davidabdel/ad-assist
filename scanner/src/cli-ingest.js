// Manual test harness: node src/cli-ingest.js <url> [outfile]
import { ingestProduct } from './ingest.js';
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
if (!url) { console.error('usage: node src/cli-ingest.js <product-url> [out.json]'); process.exit(1); }

const t0 = Date.now();
const data = await ingestProduct(url);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n=== ${data.final_url}  (HTTP ${data.http_status}, ${secs}s) ===`);
console.log('structured source :', data.structured_source ?? 'NONE');
if (data.structured) {
  const s = data.structured;
  console.log('product           :', s.product_name);
  console.log('brand             :', s.brand_name ?? '-');
  console.log('price             :', s.price ?? '-', s.currency ?? '');
  console.log('images            :', (s.images || []).length);
}
console.log('markdown chars    :', data.markdown.length);
console.log('review widget     :', data.review_widget ?? 'none');
console.log('reviews harvested :', data.reviews.length);
if (data.reviews[0]) console.log('first review      :', JSON.stringify(data.reviews[0].text.slice(0, 140)));
console.log('warnings          :', data.warnings.length ? data.warnings : 'none');

if (process.argv[3]) { writeFileSync(process.argv[3], JSON.stringify(data, null, 2)); console.log('\nwrote', process.argv[3]); }
process.exit(0);
