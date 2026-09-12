import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicIPv4, publicUrl, publicFetch } from '../src/lib/ingest/public-fetch.ts';

test('public storefront addresses accepted, private and reserved destinations rejected', () => {
  assert.equal(publicUrl('https://shop.example.com/products/shoe').pathname, '/products/shoe');
  for (const ip of ['0.0.0.0', '10.1.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1']) {
    assert.equal(publicIPv4(ip), false, ip);
  }
  assert.equal(publicIPv4('1.1.1.1'), true);
  assert.equal(publicIPv4('8.8.8.8'), true);
});

test('URL parser blocks credentials, alternate ports, encoded IPs and non-web protocols', () => {
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'http://example.com:8080', 'http://localhost', 'http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'https://example.com.']) {
    assert.throws(() => publicUrl(url), undefined, url);
  }
});

test('fetch refuses local destinations before opening a connection', async () => {
  await assert.rejects(publicFetch('http://169.254.169.254/latest/meta-data', {}, 100));
});

// Exercise network boundary behavior without making any network connections.
const { default: dns } = await import('node:dns/promises');
const { default: https } = await import('node:https');
const { syncBuiltinESMExports } = await import('node:module');
const { EventEmitter } = await import('node:events');

test('connection uses the validated IP and rejects redirects to private networks', async () => {
  const originalLookup = dns.lookup;
  const originalRequest = https.request;
  let lookups = 0;
  let redirects = false;
  dns.lookup = async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; };
  https.request = (_url, options, callback) => {
    assert.equal(options.family, 4);
    options.lookup('host', {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
    });
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = redirects ? 302 : 200;
      res.headers = redirects ? { location: 'http://169.254.169.254/' } : { 'content-type': 'text/html' };
      res.resume = () => {};
      callback(res);
      if (!redirects) { res.emit('data', Buffer.from('<html>Product</html>')); res.emit('end'); }
    };
    return req;
  };
  syncBuiltinESMExports();
  try {
    const result = await publicFetch('https://store.example.com/product', {}, 1000);
    assert.equal(await result.text(), '<html>Product</html>');
    assert.equal(lookups, 1, 'no DNS lookup between validation and connection');
    redirects = true;
    await assert.rejects(publicFetch('https://store.example.com/product', {}, 1000));
    assert.equal(lookups, 2, 'private redirect rejected before another DNS lookup');
  } finally { dns.lookup = originalLookup; https.request = originalRequest; syncBuiltinESMExports(); }
});
