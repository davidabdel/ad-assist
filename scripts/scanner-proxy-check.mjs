import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import ts from 'typescript';

const encode = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const addresses = encode(await readFile('src/lib/ingest/public-fetch.ts', 'utf8'));
const source = (await readFile('src/lib/scanner/public-proxy.ts', 'utf8'))
  .replace("'../ingest/public-fetch'", JSON.stringify(addresses));
const { startPublicProxy } = await import(encode(source));
const proxy = await startPublicProxy();
try {
  for (const target of ['http://127.0.0.1', 'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1', 'http://[::1]', 'http://localhost', 'http://user:password@example.com',
    'file:///etc/passwd', 'http://example.com:9333']) {
    const status = await new Promise((resolve, reject) => {
      const req = request(proxy.url, { path: target, method: 'GET' }, res => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403, target);
  }
  for (const target of ['127.0.0.1:443', '169.254.169.254:443', 'example.com:9333']) {
    const status = await new Promise((resolve, reject) => {
      const req = request(proxy.url, { path: target, method: 'CONNECT' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403, target);
  }
  console.log('PASS scanner proxy blocks private HTTP/HTTPS, metadata, credentials, files, and alternate ports');
} finally { await proxy.close(); }
