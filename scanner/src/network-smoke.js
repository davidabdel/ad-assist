// Run only on the dedicated scanner Docker network after host/network.sh.
import assert from 'node:assert/strict';
const publicPage = await fetch('https://example.com', { signal: AbortSignal.timeout(15000) });
assert.equal(publicPage.status, 200, 'public HTTPS and DNS work');
for (const host of ['172.30.80.1', '172.17.0.1', '10.0.0.1', '169.254.169.254', '185.205.246.203']) {
  await assert.rejects(fetch(`http://${host}/`, { signal: AbortSignal.timeout(3000) }), `blocked ${host}`);
}
console.log('PASS: public HTTPS works; host, bridge, private and metadata addresses are blocked');
