import { collectBrandEvidence } from './src/lib/pipeline/brand-sources';

const url = process.argv[2];
const e = await collectBrandEvidence(url);
console.log('site_name:', e.site_name);
console.log('radius:', e.radius);
console.log('google_fonts:', e.google_fonts);
console.log('\nCOLOURS');
for (const c of e.colours.slice(0, 12)) {
  console.log(` ${c.hex} w=${c.weight.toFixed(1)} hits=${c.hits}`,
    c.onAction ? 'ACTION' : '', c.onChrome ? 'CHROME' : '', c.names.join(','));
}
console.log('\nNEUTRALS');
for (const c of e.neutrals.slice(0, 6)) console.log(` ${c.hex} w=${c.weight.toFixed(1)} hits=${c.hits}`);
console.log('\nFONTS');
for (const f of e.fonts) console.log(` ${f.family} [${f.role}] x${f.hits}`);
console.log('\nIMAGES');
for (const [i, img] of e.images.entries()) console.log(` ${i}: ${img.why}\n    ${img.url}`);
console.log('\nNOTES', e.notes);
