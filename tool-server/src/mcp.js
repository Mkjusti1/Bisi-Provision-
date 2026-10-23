import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { initializeTransaction, verifyTransaction, PaystackError } from './paystack.js';

const apiBase = () => process.env.MOCK_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}/api`;

// Calls the order API over HTTP, so the MCP layer treats it as an external system.
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.AUTH_TOKEN}`;
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('order API call failed:', method, path, e.message);
    return { ok: false, status: 0, body: { error: { code: 'ORDER_SYSTEM_UNREACHABLE', message: e.message } } };
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, body: json };
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (code, message, extra = {}) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra } }) }],
});
const fromApiError = (r) => {
  const e = r.body?.error || {};
  return fail(e.code || 'ORDER_SYSTEM_ERROR', e.message || `Order system returned HTTP ${r.status}`,
    e.details ? { details: e.details } : {});
};

const publicOrder = (o) => ({
  order_id: o.id, status: o.status, items: o.items, subtotal: o.subtotal, delivery_fee: o.delivery_fee,
  total: o.total, zone: o.zone, address: o.address, expires_at: o.expires_at,
  ...(o.delivery_estimate ? { delivery_estimate: o.delivery_estimate } : {}),
});

// Paystack requires a valid email, but WhatsApp customers do not have one on file.
// example.com is reserved for documentation, so receipts sent here go nowhere.
// For real customers: capture their email, or use a domain Bisi owns (CUSTOMER_EMAIL_DOMAIN).
const placeholderEmail = (phone) =>
  `${String(phone).replace(/\D/g, '') || 'customer'}@${process.env.CUSTOMER_EMAIL_DOMAIN || 'example.com'}`;

export function buildMcpServer() {
  const server = new McpServer({ name: 'bisi-provisions', version: '1.0.0' });

  server.tool(
    'get_products',
    'List products with current price (naira) and stock. Pass sku for one product. Always call before quoting prices or stock.',
    { sku: z.string().optional().describe('Optional product SKU, e.g. RICE50') },
    async ({ sku }) => {
      const r = await api(sku ? `/products/${encodeURIComponent(sku)}` : '/products');
      if (!r.ok) return fromApiError(r);
      const list = r.body.products || [r.body.product];
      if (!list.length) return fail('NO_PRODUCTS', 'The catalog returned no products');
      return ok({ products: list });
    },
  );

  server.tool(
    'get_delivery_fee',
    'Get the delivery fee for a zone ("mainland" or "island") and items subtotal in naira.',
    { zone: z.string().describe('"mainland" or "island"'), subtotal: z.number().nonnegative() },
    async ({ zone, subtotal }) => {
      const r = await api(`/delivery-fee?zone=${encodeURIComponent(zone)}&subtotal=${subtotal}`);
      return r.ok ? ok(r.body) : fromApiError(r);
    },
  );

  server.tool(
    'create_order',
    'Validate stock and minimum order, reserve stock for 30 minutes, and create a Paystack (test mode) payment link. Returns order_id, total, payment_url and expires_at.',
    {
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
      zone: z.string().describe('"mainland" or "island"'),
      address: z.string(),
      customer_name: z.string(),
      customer_phone: z.string(),
    },
    async (args) => {
      const created = await api('/orders', { method: 'POST', body: args });
      if (!created.ok) return fromApiError(created);
      const order = created.body.order;

      const reference = `${order.id}-${randomBytes(3).toString('hex')}`;
      let pay;
      try {
        pay = await initializeTransaction({
          email: placeholderEmail(args.customer_phone),
          amountNaira: order.total,
          reference,
          metadata: { order_id: order.id, customer_name: order.customer_name },
        });
      } catch (e) {
        // Roll back the stock reservation so nothing is held for a link that never existed.
        console.error('Paystack initialize failed:', e.kind, e.status, e.message, JSON.stringify(e.body ?? null).slice(0, 500));
        await api(`/orders/${order.id}/release`, { method: 'POST' });
        const kind = e instanceof PaystackError ? e.kind : 'provider';
        return fail('PAYMENT_PROVIDER_ERROR',
          'Could not create the payment link. The order was cancelled and stock released. Try once more, then hand over to Bisi.',
          { cause: kind });
      }

      const saved = await api(`/orders/${order.id}/payment`, {
        method: 'PATCH', body: { reference: pay.reference, payment_url: pay.payment_url },
      });
      if (!saved.ok) return fromApiError(saved);
      return ok({ ...publicOrder(saved.body.order), payment_url: pay.payment_url });
    },
  );

  server.tool(
    'verify_payment',
    'Check Paystack for the order payment. status is "paid" (also returns delivery_estimate), "pending", "failed", "abandoned", "expired", or "needs_review" (hand over to Bisi).',
    { order_id: z.string() },
    async ({ order_id }) => {
      const got = await api(`/orders/${encodeURIComponent(order_id)}`);
      if (!got.ok) return fromApiError(got);
      const order = got.body.order;
      if (order.status === 'paid') return ok(publicOrder(order)); // already confirmed
      if (!order.payment_reference)
        return fail('NO_PAYMENT_LINK', 'This order has no payment link yet.');

      let tx;
      try {
        tx = await verifyTransaction(order.payment_reference);
      } catch (e) {
        return fail('PAYMENT_CHECK_FAILED',
          'Could not check the payment with Paystack right now. Do not confirm the order. Try once more, then hand over to Bisi.',
          { cause: e instanceof PaystackError ? e.kind : 'provider' });
      }

      if (tx.status === 'success') {
        if (tx.amountKobo !== order.total * 100 || tx.currency !== 'NGN')
          return ok({ order_id, status: 'needs_review',
            message: 'Amount or currency does not match the order. Hand over to Bisi; do not confirm.' });
        const confirmed = await api(`/orders/${order_id}/confirm`, { method: 'POST' });
        if (confirmed.ok) return ok(publicOrder(confirmed.body.order));
        if (confirmed.body?.error?.code === 'ORDER_NOT_PAYABLE')
          return ok({ order_id, status: 'needs_review',
            message: 'Payment succeeded after the order expired and stock was released. Hand over to Bisi; tell the customer not to pay again.' });
        return fromApiError(confirmed);
      }
      if (tx.status === 'failed' || tx.status === 'reversed')
        return ok({ order_id, status: 'failed', expires_at: order.expires_at });
      if (order.status !== 'pending_payment')
        return ok({ order_id, status: 'expired', message: 'The order expired and stock was released.' });
      if (tx.status === 'abandoned') return ok({ order_id, status: 'abandoned', expires_at: order.expires_at });
      return ok({ order_id, status: 'pending', expires_at: order.expires_at });
    },
  );

  server.tool(
    'release_order',
    'Cancel an unpaid order and free the reserved stock. Cannot release a paid order.',
    { order_id: z.string() },
    async ({ order_id }) => {
      const r = await api(`/orders/${encodeURIComponent(order_id)}/release`, { method: 'POST' });
      return r.ok ? ok(publicOrder(r.body.order)) : fromApiError(r);
    },
  );

  server.tool(
    'get_order',
    'Get the current state of an order by order_id.',
    { order_id: z.string() },
    async ({ order_id }) => {
      const r = await api(`/orders/${encodeURIComponent(order_id)}`);
      return r.ok ? ok(publicOrder(r.body.order)) : fromApiError(r);
    },
  );

  return server;
}