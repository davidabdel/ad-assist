// node src/cli-scan.js <region> <image|video> "<term>" [ceiling] [out.json]
import { scanAdLibrary } from './adlibrary.js';
import { writeFileSync } from 'node:fs';

const [region, mediaType, term, ceiling = '60', out] = process.argv.slice(2);
if (!term) { console.error('usage: node src/cli-scan.js AU image "wireless earbuds" [ceiling] [out.json]'); process.exit(1); }

const t0 = Date.now();
const r = await scanAdLibrary({ region, mediaType, term, ceiling: Number(ceiling),
  onProgress: (n) => process.stdout.write(`\r  harvested ${n}...   `) });
console.log(`\n\n=== ${region} / ${mediaType} / "${term}"  (${((Date.now()-t0)/1000).toFixed(1)}s) ===`);
console.log('url        :', r.url);
console.log('found      :', r.found);
console.log('qualified  :', r.qualified, '(active AND 90+ days)');
console.log('notes      :', r.notes.length ? r.notes : 'none');
const dated = r.ads.filter(a => a.days_running != null).sort((a,b)=>b.days_running-a.days_running);
console.log('\ntop by run time:');
for (const a of dated.slice(0,5)) {
  console.log(`  ${String(a.days_running).padStart(4)}d  active=${a.is_active}  variants=${a.variant_count ?? '-'}  ${(a.advertiser||'?').slice(0,28)}`);
  console.log(`        ${(a.text||'').slice(0,110)}`);
}
if (out) { writeFileSync(out, JSON.stringify(r, null, 2)); console.log('\nwrote', out); }
process.exit(0);
