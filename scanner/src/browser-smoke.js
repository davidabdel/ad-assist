// Runs a real browser without Supabase credentials or generation providers.
import assert from 'node:assert/strict';
import { getBrowser, newPage } from './browser.js';
import { ingestProduct } from './ingest.js';
assert.equal(typeof ingestProduct, 'function', 'shared product extractor loads');
let browser;
try {
  browser = await getBrowser();
  const page = await newPage(browser);
  await page.goto('data:text/html,<title>AdtoCart scanner check</title><h1>Ready</h1>');
  assert.equal(await page.title(), 'AdtoCart scanner check');
  assert.equal(await page.$eval('h1', el => el.textContent), 'Ready');
  await page.goto('chrome://sandbox');
  const sandbox = await page.$eval('body', el => el.innerText);
  assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/i);
  assert.match(sandbox, /Layer 1 Sandbox\s+Namespace|Namespace sandbox\s+Yes|SUID sandbox\s+Yes/i);
  assert.match(sandbox, /PID namespaces\s+Yes/i);
  assert.match(sandbox, /Network namespaces\s+Yes/i);
  console.log('PASS: worker imports, Chromium rendering, namespace/SUID and seccomp sandbox');
} finally {
  if (browser) await browser.close();
}
