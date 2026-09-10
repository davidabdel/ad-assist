/**
 * Proof that the Mac-side worker actually drives the pipeline.
 *
 * The route it calls is checked separately, against a real campaign and a real
 * database (`keep-going-check.mjs`). What is checked HERE is the half that
 * cannot be: that the worker sends the request at all, signs it, and does not
 * send it four times a second.
 *
 * That half matters more than it sounds. The whole point of the tick is that
 * nobody is watching — a worker that silently never poked would look exactly
 * like a worker that was poking, right up until a campaign sat still overnight.
 *
 * Nothing here touches a campaign. The worker talks to a throwaway HTTP server
 * on a random port that records what arrives and answers with an empty result,
 * so no pipeline work happens and nothing is billed.
 *
 *   node scripts/worker-poke-check.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const SECRET = env.CRON_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const pokes = [];
const server = createServer((req, res) => {
  pokes.push({
    at: Date.now(),
    method: req.method,
    url: req.url,
    auth: req.headers.authorization ?? '',
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  // The shape the worker reads. An empty list is a tick that found nothing to
  // do, which is the honest answer here.
  res.end(JSON.stringify({ driven: [], looked_at: 0 }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const TICK_EVERY_MS = 1500;
console.log(`\nthe worker drives the pipeline (recorder on ${port})`);

const worker = spawn('node', [new URL('../scanner/src/worker.js', import.meta.url).pathname], {
  env: {
    ...process.env,
    TICK_URL: `http://127.0.0.1:${port}/api/tick`,
    TICK_EVERY_MS: String(TICK_EVERY_MS),
    // Fast, so five seconds is a fair sample of the loop rather than one pass.
    SCANNER_POLL_MS: '300',
    SCANNER_WORKER_ID: 'poke-check',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
worker.stdout.on('data', (d) => { out += d; });
worker.stderr.on('data', (d) => { out += d; });

await new Promise((r) => { setTimeout(r, 5_500); });
worker.kill('SIGTERM');
await new Promise((r) => { server.close(r); });

check('it says on startup that it is driving campaigns',
  /Driving campaigns at http:\/\/127\.0\.0\.1/.test(out), out.split('\n')[2] ?? '');
check('it poked the tick', pokes.length > 0, `${pokes.length} in 5.5s`);
check('as a POST to /api/tick',
  pokes.every((p) => p.method === 'POST' && p.url === '/api/tick'),
  pokes[0] ? `${pokes[0].method} ${pokes[0].url}` : 'nothing arrived');
check('signed with the shared secret',
  Boolean(SECRET) && pokes.every((p) => p.auth === `Bearer ${SECRET}`),
  pokes[0] ? `${pokes[0].auth.slice(0, 14)}…` : 'nothing arrived');

// The loop spins every 300ms here. Without the throttle that would be three
// pokes a second at a route that writes landing pages.
const gaps = pokes.slice(1).map((p, i) => p.at - pokes[i].at);
check('and throttled, not once per loop',
  gaps.length > 0 && gaps.every((g) => g >= TICK_EVERY_MS - 100),
  gaps.length ? `gaps: ${gaps.join('ms, ')}ms` : 'only one poke to compare');

// The other half of the throttle: it must not just be slow, it must keep going.
check('and it keeps poking rather than doing it once',
  pokes.length >= 3, `${pokes.length} pokes`);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
