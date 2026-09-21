import { createServer, request as requestHttp, type OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Socket } from 'node:net';
import { publicIPv4 } from '../ingest/public-fetch';

/** Resolve once, reject private destinations, and connect to that exact IP. */
async function destination(raw: string) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port)) || !url.hostname.includes('.')
      || url.hostname.endsWith('.')) throw new Error('Destination blocked');
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address))) {
    throw new Error('Destination blocked');
  }
  return { url, address: addresses[0].address };
}

/** Browser-wide proxy, including redirects, subresources, and CONNECT tunnels. */
export async function startPublicProxy() {
  const sockets = new Set<Socket>();
  let bytes = 0;
  let closed = false;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(60_000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 100 * 1024 * 1024) for (const open of sockets) open.destroy();
    });
    return socket;
  };
  const server = createServer(async (req, res) => {
    try {
      const { url, address } = await destination(req.url ?? '');
      if (closed || bytes > 100 * 1024 * 1024) throw new Error('Proxy budget exhausted');
      if (url.protocol !== 'http:') throw new Error('Use CONNECT for HTTPS');
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = requestHttp(url, {
        method: req.method, headers, family: 4,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        signal: AbortSignal.timeout(45_000),
      }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on('socket', track);
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    } catch { res.writeHead(403); res.end('Destination blocked'); }
  });
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    try {
      const { url, address } = await destination(`https://${req.url}`);
      if (closed || client.destroyed || bytes > 100 * 1024 * 1024) throw new Error('Proxy budget exhausted');
      if (url.port && url.port !== '443') throw new Error('Destination blocked');
      const upstream = track(connect({ host: address, port: 443, family: 4 }));
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.once('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy did not start');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
