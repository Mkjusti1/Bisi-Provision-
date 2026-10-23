// End-to-end test: real MCP client -> MCP server -> mock API, with a fake Paystack.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { fakePaystack } from './fake-paystack.js';

const PS_PORT = 4310, APP_PORT = 4311;
process.env.PORT = APP_PORT;
process.env.PAYSTACK_SECRET_KEY = 'sk_test_fake';
process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${PS_PORT}`;
process.env.ENABLE_ADMIN = 'true';
process.env.AUTH_TOKEN = 'test-token';

const ps = fakePaystack().listen(PS_PORT);
const app = createApp().listen(APP_PORT);

const headers = { Authorization: 'Bearer test-token' };
const client = new Client({ name: 'e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${APP_PORT}/mcp`), { requestInit: { headers } }));

const post = (path, body) => fetch(`http://127.0.0.1:${APP_PORT}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const psCtl = (path, body) => fetch(`http://127.0.0.1:${PS_PORT}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
};
const stockOf = async (sku) => (await call('get_products', { sku })).data.products[0].stock;
const customer = { zone: 'mainland', address: '12 Allen Ave, Ikeja', customer_name: 'Test Buyer', customer_phone: '+234 801 000 0000' };

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

await post('/api/admin/reset');

await test('lists the six tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['create_order', 'get_delivery_fee', 'get_order', 'get_products', 'release_order', 'verify_payment']);
});

await test('rejects calls without the bearer token', async () => {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/products`);
  assert.equal(r.status, 401);
});

await test('get_products returns 9 products, palm oil out of stock', async () => {
  const { data } = await call('get_products');
  assert.equal(data.products.length, 9);
  assert.equal(data.products.find((p) => p.sku === 'PALM25').stock, 0);
});

await test('unknown sku is an error', async () => {
  const r = await call('get_products', { sku: 'NOPE' });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'UNKNOWN_SKU');
});

await test('out of stock order is refused with details', async () => {
  const r = await call('create_order', { items: [{ sku: 'PALM25', quantity: 1 }], ...customer });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'OUT_OF_STOCK');
  assert.equal(r.data.error.details.items[0].available, 0);
});

await test('below-minimum order is refused', async () => {
  const r = await call('create_order', { items: [{ sku: 'SEMO10', quantity: 1 }], ...customer });
  assert.equal(r.data.error.code, 'BELOW_MINIMUM');
});

await test('delivery fee rules (free mainland over 150k, island flat)', async () => {
  assert.equal((await call('get_delivery_fee', { zone: 'Mainland', subtotal: 160000 })).data.fee, 0);
  assert.equal((await call('get_delivery_fee', { zone: 'mainland', subtotal: 100000 })).data.fee, 5000);
  assert.equal((await call('get_delivery_fee', { zone: 'island', subtotal: 500000 })).data.fee, 8000);
  assert.equal((await call('get_delivery_fee', { zone: 'abuja', subtotal: 1 })).isError, true);
});

let order;
await test('create_order reserves stock and returns a payment link', async () => {
  const r = await call('create_order', { items: [{ sku: 'RICE50', quantity: 2 }, { sku: 'VEGO25', quantity: 1 }], ...customer });
  assert.equal(r.isError, false);
  order = r.data;
  assert.equal(order.total, 238000); // 170000 + 68000, free mainland delivery
  assert.match(order.payment_url, /checkout\.paystack\.test/);
  assert.equal(await stockOf('RICE50'), 38);
});

await test('verify_payment: unpaid link is abandoned/pending, not paid', async () => {
  const r = await call('verify_payment', { order_id: order.order_id });
  assert.ok(['abandoned', 'pending'].includes(r.data.status), r.data.status);
});

await test('verify_payment: Paystack outage never confirms the order', async () => {
  await psCtl('/_mode', { verifyFails: true });
  const r = await call('verify_payment', { order_id: order.order_id });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'PAYMENT_CHECK_FAILED');
  await psCtl('/_mode', { verifyFails: false });
});

await test('verify_payment: success confirms order with delivery estimate', async () => {
  const ref = (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/orders/${order.order_id}`, { headers })).json()).order.payment_reference;
  await psCtl(`/_set/${ref}/success`);
  const r = await call('verify_payment', { order_id: order.order_id });
  assert.equal(r.data.status, 'paid');
  assert.ok(r.data.delivery_estimate);
  const again = await call('verify_payment', { order_id: order.order_id }); // idempotent
  assert.equal(again.data.status, 'paid');
});

await test('paid order cannot be released', async () => {
  const r = await call('release_order', { order_id: order.order_id });
  assert.equal(r.data.error.code, 'ORDER_ALREADY_PAID');
});

await test('release_order frees reserved stock', async () => {
  const o = (await call('create_order', { items: [{ sku: 'GARI50', quantity: 3 }], ...customer })).data;
  assert.equal(await stockOf('GARI50'), 47);
  await call('release_order', { order_id: o.order_id });
  assert.equal(await stockOf('GARI50'), 50);
});

await test('Paystack init failure rolls the reservation back', async () => {
  await psCtl('/_mode', { initFails: true });
  const r = await call('create_order', { items: [{ sku: 'SUGR50', quantity: 2 }], ...customer });
  assert.equal(r.data.error.code, 'PAYMENT_PROVIDER_ERROR');
  assert.equal(await stockOf('SUGR50'), 15);
  await psCtl('/_mode', { initFails: false });
});

await test('payment that lands after expiry goes to needs_review', async () => {
  const o = (await call('create_order', { items: [{ sku: 'BEAN50', quantity: 1 }], ...customer })).data;
  await post(`/api/admin/expire/${o.order_id}`);
  assert.equal(await stockOf('BEAN50'), 25); // released on expiry
  const ref = (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/orders/${o.order_id}`, { headers })).json()).order.payment_reference;
  await psCtl(`/_set/${ref}/success`);
  const r = await call('verify_payment', { order_id: o.order_id });
  assert.equal(r.data.status, 'needs_review');
});

await test('failed payment is reported as failed', async () => {
  const o = (await call('create_order', { items: [{ sku: 'RICE25', quantity: 1 }], ...customer })).data;
  const ref = (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/orders/${o.order_id}`, { headers })).json()).order.payment_reference;
  await psCtl(`/_set/${ref}/failed`);
  assert.equal((await call('verify_payment', { order_id: o.order_id })).data.status, 'failed');
});

console.log(`\n${passed} tests passed`);
await client.close();
ps.close(); app.close();
process.exit(0);
