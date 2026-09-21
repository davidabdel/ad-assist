import assert from 'node:assert/strict';
import { trustedClientAddress } from '../src/lib/client-address.ts';

const previous = { NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL };
try {
  process.env.NODE_ENV = 'production';
  delete process.env.VERCEL;
  const forged = new Request('https://example.test', { headers: {
    'x-forwarded-for': '1.1.1.1', 'x-nf-client-connection-ip': '2.2.2.2',
    'x-vercel-forwarded-for': '3.3.3.3',
  } });
  assert.equal(trustedClientAddress(forged), null, 'unknown production gateways must fail closed');
  // Reproduce the official SDK's request context, not caller-controlled headers.
  const store = globalThis[Symbol.for('@netlify/functions/request-context-store')];
  store.run({ context: { ip: '8.8.8.8' } }, () => {
    assert.equal(trustedClientAddress(forged), '8.8.8.8');
  });
  store.run({ context: { ip: 'invalid' } }, () => assert.equal(trustedClientAddress(forged), null));
  process.env.VERCEL = '1';
  assert.equal(trustedClientAddress(forged), '3.3.3.3');
  assert.equal(trustedClientAddress(new Request('https://example.test')), null);
  delete process.env.VERCEL;
  process.env.NODE_ENV = 'development';
  assert.equal(trustedClientAddress(forged), 'local-development');
  console.log('PASS trusted platform addresses, spoofed-header rejection, and production fail-closed behavior');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
