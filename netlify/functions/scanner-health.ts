import { timingSafeEqual } from 'node:crypto';
import { launchServerlessBrowser } from '../../src/lib/scanner/serverless-browser';

/** Authenticated deployment probe; reads a fixed public page, never customer jobs. */
export default async function handler(req: Request) {
  const expected = process.env.CRON_SECRET;
  const offered = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (req.method !== 'POST' || !expected || !offered || Buffer.byteLength(offered) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(offered), Buffer.from(expected))) return new Response(null, { status: 401 });
  const runtime = await launchServerlessBrowser();
  try {
    const page = await runtime.browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title();
    let privateBlocked = false;
    try {
      const response = await page.goto('http://127.0.0.1', { waitUntil: 'domcontentloaded', timeout: 5_000 });
      privateBlocked = response?.status() === 403;
    } catch { privateBlocked = false; }
    return Response.json({ title, privateBlocked, browser: await runtime.browser.version(), node: process.version });
  } finally { await runtime.close(); }
}
