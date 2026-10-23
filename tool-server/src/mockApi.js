import express from 'express';
import { state, reset, RULES, deliveryFee, deliveryEstimate, expireIfNeeded, releaseStock } from './store.js';

const err = (res, status, code, message, details) =>
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });

export function mockApi() {
  const r = express.Router();

  r.get('/products', (_req, res) => res.json({ products: [...state.products.values()] }));

  r.get('/products/:sku', (req, res) => {
    const p = state.products.get(req.params.sku.toUpperCase());
    if (!p) return err(res, 404, 'UNKNOWN_SKU', `No product with sku ${req.params.sku}`);
    res.json({ product: p });
  });

  r.get('/delivery-fee', (req, res) => {
    const subtotal = Number(req.query.subtotal ?? 0);
    const f = deliveryFee(req.query.zone, subtotal);
    if (!f) return err(res, 422, 'INVALID_ZONE', 'Zone must be "mainland" or "island"');
    res.json({ ...f, subtotal });
  });

  r.post('/orders', (req, res) => {
    const { items, zone, address, customer_name, customer_phone } = req.body || {};
    if (!Array.isArray(items) || items.length === 0)
      return err(res, 422, 'INVALID_ITEMS', 'items must be a non-empty list');
    for (const [k, v] of Object.entries({ zone, address, customer_name, customer_phone }))
      if (!v || !String(v).trim()) return err(res, 422, 'MISSING_FIELD', `${k} is required`);

    // merge duplicate skus, validate
    const merged = new Map();
    for (const it of items) {
      const sku = String(it.sku || '').toUpperCase();
      const qty = Number(it.quantity);
      if (!state.products.has(sku)) return err(res, 422, 'UNKNOWN_SKU', `Unknown sku ${it.sku}`);
      if (!Number.isInteger(qty) || qty < 1)
        return err(res, 422, 'INVALID_ITEMS', `Quantity for ${sku} must be a whole number of at least 1`);
      merged.set(sku, (merged.get(sku) || 0) + qty);
    }
    const short = [];
    for (const [sku, qty] of merged) {
      const p = state.products.get(sku);
      if (p.stock < qty) short.push({ sku, name: p.name, requested: qty, available: p.stock });
    }
    if (short.length)
      return err(res, 422, 'OUT_OF_STOCK', 'Some items are out of stock or short', { items: short });

    const lines = [...merged].map(([sku, quantity]) => {
      const p = state.products.get(sku);
      return { sku, name: p.name, quantity, unit_price: p.price, line_total: p.price * quantity };
    });
    const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
    if (subtotal < RULES.minOrder)
      return err(res, 422, 'BELOW_MINIMUM', `Minimum order is ₦${RULES.minOrder}`, { subtotal, minimum: RULES.minOrder });
    const f = deliveryFee(zone, subtotal);
    if (!f) return err(res, 422, 'INVALID_ZONE', 'Zone must be "mainland" or "island"');

    // reserve stock
    for (const l of lines) state.products.get(l.sku).stock -= l.quantity;

    const id = `ORD-${++state.counter}`;
    const now = new Date();
    const order = {
      id, status: 'pending_payment', items: lines, subtotal, delivery_fee: f.fee,
      total: subtotal + f.fee, zone: f.zone, address: String(address).trim(),
      customer_name: String(customer_name).trim(), customer_phone: String(customer_phone).trim(),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + RULES.reservationMinutes * 60000).toISOString(),
      payment_reference: null, payment_url: null, paid_at: null, delivery_estimate: null,
    };
    state.orders.set(id, order);
    res.status(201).json({ order });
  });

  const find = (req, res) => {
    const o = state.orders.get(req.params.id);
    if (!o) { err(res, 404, 'ORDER_NOT_FOUND', `No order ${req.params.id}`); return null; }
    return expireIfNeeded(o);
  };

  r.get('/orders/:id', (req, res) => {
    const o = find(req, res);
    if (o) res.json({ order: o });
  });

  r.patch('/orders/:id/payment', (req, res) => {
    const o = find(req, res);
    if (!o) return;
    o.payment_reference = req.body?.reference ?? o.payment_reference;
    o.payment_url = req.body?.payment_url ?? o.payment_url;
    res.json({ order: o });
  });

  r.post('/orders/:id/confirm', (req, res) => {
    const o = find(req, res);
    if (!o) return;
    if (o.status === 'paid') return res.json({ order: o }); // idempotent
    if (o.status !== 'pending_payment')
      return err(res, 409, 'ORDER_NOT_PAYABLE', `Order is ${o.status}; stock was already released`);
    o.status = 'paid';
    o.paid_at = new Date().toISOString();
    o.delivery_estimate = deliveryEstimate(new Date(o.paid_at));
    res.json({ order: o });
  });

  r.post('/orders/:id/release', (req, res) => {
    const o = find(req, res);
    if (!o) return;
    if (o.status === 'paid') return err(res, 409, 'ORDER_ALREADY_PAID', 'A paid order cannot be released');
    if (o.status === 'pending_payment') {
      releaseStock(o);
      o.status = 'released';
    }
    res.json({ order: o }); // already released/expired: no-op
  });

  // Demo/test helpers, only when ENABLE_ADMIN=true
  r.post('/admin/reset', (_req, res) => {
    if (process.env.ENABLE_ADMIN !== 'true') return err(res, 404, 'NOT_FOUND', 'Not found');
    reset();
    res.json({ ok: true });
  });
  r.post('/admin/expire/:id', (req, res) => {
    if (process.env.ENABLE_ADMIN !== 'true') return err(res, 404, 'NOT_FOUND', 'Not found');
    const o = state.orders.get(req.params.id);
    if (!o) return err(res, 404, 'ORDER_NOT_FOUND', 'No such order');
    o.expires_at = new Date(Date.now() - 1000).toISOString();
    res.json({ order: expireIfNeeded(o) });
  });

  return r;
}
