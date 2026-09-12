import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';

// Resolve once and pin the connection to the checked address. A second DNS
// lookup at connect time would let a hostile hostname rebind to a private IP.
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

export function publicUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.')
      || (isIP(url.hostname) && !publicIPv4(url.hostname))) {
    throw new Error('Use a public product page with a standard web address.');
  }
  return url;
}

export async function publicFetch(raw: string, headers: Record<string, string>, ms: number) {
  const deadline = Date.now() + ms;
  let url = publicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const addresses = await lookup(url.hostname, { family: 4, all: true });
    if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address))) {
      throw new Error('That address does not point to a public website.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('The store took too long to respond.');
    const result = await new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, {
        family: 4,
        headers: { ...headers, 'Accept-Encoding': 'identity' },
        lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
        signal: AbortSignal.timeout(remaining),
      }, (res) => {
        const status = res.statusCode ?? 502;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          resolve({ status, location: res.headers.location, body: '' });
          return;
        }
        if (!/text\/|application\/(json|ld\+json|xhtml\+xml|javascript)/i.test(res.headers['content-type'] ?? '')) {
          res.destroy(); reject(new Error('This address is not a readable product page.')); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2_000_000) {
            res.destroy(new Error('The page is too large for the free scan.')); return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    if (result.location) { url = publicUrl(new URL(result.location, url).href); continue; }
    return { ok: result.status >= 200 && result.status < 300, status: result.status,
      url: url.href, text: async () => result.body };
  }
  throw new Error('The store redirected too many times.');
}
