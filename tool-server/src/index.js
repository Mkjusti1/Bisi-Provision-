import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => {
  console.log(`Bisi Provisions tool server on :${port}  (MCP at /mcp, mock API at /api)`);
  if (!(process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_test_'))
    console.warn('WARNING: PAYSTACK_SECRET_KEY is not set to an sk_test_ key; create_order will fail.');
  if (!process.env.AUTH_TOKEN) console.warn('WARNING: AUTH_TOKEN not set; endpoints are public.');
});
