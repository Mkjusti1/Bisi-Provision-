// Thin Paystack client. Test mode only: refuses anything but sk_test_ keys.

export class PaystackError extends Error {
  constructor(message, { status, body, kind } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.kind = kind || 'provider';
  }
}

async function call(path, init = {}) {
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  if (!key.startsWith('sk_test_'))
    throw new PaystackError('PAYSTACK_SECRET_KEY missing or not a test key (sk_test_...)', { kind: 'config' });
  const base = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
  let res;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new PaystackError(`Could not reach Paystack: ${e.message}`, { kind: 'network' });
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || !body || body.status === false)
    throw new PaystackError(body?.message || `Paystack returned HTTP ${res.status}`, { status: res.status, body });
  return body;
}

export async function initializeTransaction({ email, amountNaira, reference, metadata }) {
  const body = await call('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({ email, amount: Math.round(amountNaira * 100), currency: 'NGN', reference, metadata }),
  });
  const d = body.data || {};
  if (!d.authorization_url) throw new PaystackError('Paystack returned no payment link', { body });
  return { payment_url: d.authorization_url, reference: d.reference || reference };
}

export async function verifyTransaction(reference) {
  const body = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
  const d = body.data || {};
  return { status: d.status, amountKobo: d.amount, currency: d.currency };
}
