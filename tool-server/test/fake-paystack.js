// Minimal fake of the two Paystack endpoints we use, with controllable behaviour.
import express from 'express';

export function fakePaystack() {
  const app = express();
  app.use(express.json());
  const txs = new Map(); // reference -> { amount, status }
  const mode = { initFails: false, verifyFails: false, defaultStatus: 'abandoned' };

  app.post('/transaction/initialize', (req, res) => {
    if (!String(req.headers.authorization).startsWith('Bearer sk_test_'))
      return res.status(401).json({ status: false, message: 'Invalid key' });
    if (mode.initFails) return res.status(500).json({ status: false, message: 'Paystack is down' });
    const { reference, amount, email } = req.body;
    if (!email || !amount) return res.status(400).json({ status: false, message: 'Email and amount required' });
    txs.set(reference, { amount, status: mode.defaultStatus });
    res.json({ status: true, data: { authorization_url: `https://checkout.paystack.test/${reference}`, reference } });
  });

  app.get('/transaction/verify/:ref', (req, res) => {
    if (mode.verifyFails) return res.status(500).json({ status: false, message: 'Paystack is down' });
    const t = txs.get(req.params.ref);
    if (!t) return res.status(404).json({ status: false, message: 'Transaction reference not found' });
    res.json({ status: true, data: { status: t.status, amount: t.amount, currency: 'NGN' } });
  });

  // test controls
  app.post('/_set/:ref/:status', (req, res) => { txs.get(req.params.ref).status = req.params.status; res.json({ ok: true }); });
  app.post('/_mode', (req, res) => { Object.assign(mode, req.body); res.json(mode); });
  return app;
}
