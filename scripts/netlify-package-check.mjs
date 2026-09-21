// Run after `netlify build`. Exercise the actual packaged dependencies without
// credentials, network requests, generation, or database writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'adtocart-package-'));
try {
  execFileSync('unzip', ['-q', '.netlify/functions/campaign-background.zip', '-d', directory]);
  const module = await import(pathToFileURL(join(directory, 'netlify/functions/campaign-background.cjs')));
  const handler = module.default.default ?? module.default;
  const response = await handler(new Request('https://example.test'));
  assert.equal(response.status, 401);
  const { parseHTML } = await import(pathToFileURL(join(directory, 'node_modules/linkedom/esm/index.js')));
  assert.equal(parseHTML('<main><h1>Product</h1></main>').document.querySelector('main h1').textContent, 'Product');
  console.log('PASS packaged worker startup, unauthorized rejection, and ESM HTML parser');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
