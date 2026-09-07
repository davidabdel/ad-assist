import { readBrand } from './src/lib/pipeline/brand';
import { brandVars, googleFontsHref, readableOn } from './src/lib/brand';

const { brand, branded, usage } = await readBrand(process.argv[2]);
console.log('branded:', branded, 'usage:', usage);
console.log(JSON.stringify(brand, null, 2));
console.log('fonts href:', googleFontsHref(brand));
console.log('on accent:', readableOn(brand.accent), 'on primary:', readableOn(brand.primary));
console.log('vars:', brandVars(brand));
