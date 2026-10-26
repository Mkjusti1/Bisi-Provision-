// In-memory store for the mock Bisi Provisions order system.
// Data is made up. State resets on restart (documented in the README).

const SEED = [
  { sku: 'RICE50', name: 'Local rice, 50kg bag', unit: 'bag', price: 85000, stock: 40 },
  { sku: 'RICE25', name: 'Local rice, 25kg bag', unit: 'bag', price: 44000, stock: 60 },
  { sku: 'BEAN50', name: 'Brown beans, 50kg bag', unit: 'bag', price: 95000, stock: 25 },
  { sku: 'GARI50', name: 'White garri, 50kg bag', unit: 'bag', price: 38000, stock: 50 },
  { sku: 'SUGR50', name: 'Sugar, 50kg bag', unit: 'bag', price: 75000, stock: 15 },
  { sku: 'VEGO25', name: 'Vegetable oil, 25L', unit: 'container', price: 68000, stock: 30 },
  { sku: 'PALM25', name: 'Palm oil, 25L', unit: 'container', price: 72000, stock: 0 },
  { sku: 'SEMO10', name: 'Semovita, 10kg', unit: 'bag', price: 12500, stock: 80 },
  { sku: 'SPAG20', name: 'Spaghetti, carton of 20 packs', unit: 'carton', price: 21000, stock: 45 },
];

export const RULES = {
  minOrder: 20000,
  freeMainlandFrom: 150000,
  fees: { mainland: 5000, island: 8000 },
  reservationMinutes: 30,
  cutoffHour: 14, // Lagos time
};

export const state = { products: new Map(), orders: new Map(), counter: 1000 };

export function reset() {
  state.products = new Map(SEED.map((p) => [p.sku, { ...p }]));
  state.orders = new Map();
  state.counter = 1000;
}
reset();

// ---- Lagos time helpers (WAT = UTC+1, no DST) ----
const shift = (date) => new Date(date.getTime() + 3600000);

function nextTradingDay(d) {
  // d is a "shifted" date; advance one day, skipping Sunday (0)
  const n = new Date(d.getTime());
  do {
    n.setUTCDate(n.getUTCDate() + 1);
  } while (n.getUTCDay() === 0);
  return n;
}

// Paid before 14:00 on a trading day -> processed that day, delivered next trading day.
// Otherwise processed next trading day, delivered the trading day after that.
export function deliveryEstimate(paidAt) {
  const d = shift(paidAt);
  const isTradingDay = d.getUTCDay() !== 0;
  const beforeCutoff = d.getUTCHours() < RULES.cutoffHour;
  const processing = isTradingDay && beforeCutoff ? d : nextTradingDay(d);
  const delivery = nextTradingDay(processing);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(delivery);
}

export function deliveryFee(zone, subtotal) {
  const z = String(zone || '').toLowerCase();
  if (!(z in RULES.fees)) return null;
  const free = z === 'mainland' && subtotal >= RULES.freeMainlandFrom;
  return { zone: z, fee: free ? 0 : RULES.fees[z], free_delivery: free };
}

// Lazily expire an unpaid order and give its stock back.
export function expireIfNeeded(order, now = new Date()) {
  if (order.status === 'pending_payment' && new Date(order.expires_at) <= now) {
    releaseStock(order);
    order.status = 'expired';
  }
  return order;
}

// Expire every overdue unpaid order. Called before stock is read, so abandoned
// orders give their stock back even if nobody asks about that specific order.
export function sweepExpired(now = new Date()) {
  for (const o of state.orders.values()) expireIfNeeded(o, now);
}

export function releaseStock(order) {
  for (const it of order.items) {
    const p = state.products.get(it.sku);
    if (p) p.stock += it.quantity;
  }
}