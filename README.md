# Bisi Provisions: a Chord teammate that takes orders and collects payment on WhatsApp

A Chord teammate for a made-up Lagos foodstuff reseller. It takes a bulk order from chat, checks stock and prices against a mock order API, creates a Paystack (test mode) payment link, verifies the payment, and confirms the order with a delivery date.

```
skill/          SKILL.md + references/   (uploaded to Chord as the teammate's skill)
tool-server/    Node server: mock order API (/api) + MCP endpoint (/mcp) + Paystack calls
```

## How it works

Customer (WhatsApp) -> Chord teammate (skill) -> MCP tools -> mock order API + Paystack

Tools: `get_products`, `get_delivery_fee`, `create_order`, `verify_payment`, `release_order`, `get_order`.

Error handling that is built in and tested:
- Out of stock or short stock, below-minimum order, unknown SKU or zone
- Paystack down when creating the link: the stock reservation is rolled back
- Paystack down when verifying: the order is never confirmed
- Abandoned or failed payment, and stock released after the 30-minute window
- Payment that lands after the order expired, or with the wrong amount: returned as `needs_review` and handed to the owner

## Run it locally

Requires Node 18+.

```bash
cd tool-server
npm install
cp .env.example .env   # add your sk_test_ key and a random AUTH_TOKEN
export $(grep -v '^#' .env | xargs) && npm start
```

Run the tests (no Paystack key needed; they use a local fake Paystack):

```bash
npm test
```

## Deploy

Deploy `tool-server/` to any host with a public HTTPS URL (Render, Railway, Fly). Set `PAYSTACK_SECRET_KEY` (test key) and `AUTH_TOKEN`. Start command: `npm start`. Check `GET /health`.

Order state is in memory and resets on restart. That is fine for a demo, and the go-live note says what to replace it with.

## Connect to Chord

1. Upload `skill/` (or the zip) when creating the teammate, then review, publish and activate it.
2. Register the MCP server in Chord with URL `https://<your-host>/mcp` and the bearer token from `AUTH_TOKEN`. Create it disabled, assign it to the teammate, enable it, then run tool discovery and the health check.
3. Open the WhatsApp simulator and start a chat. Example flow: "I need 2 bags of 50kg rice and a 25 litre vegetable oil, Ikeja" then pay with a Paystack test card.

## Demo helpers

With `ENABLE_ADMIN=true`: `POST /api/admin/reset` resets stock and orders, and `POST /api/admin/expire/:orderId` forces an order to expire.

## How I used AI tools

Claude (Anthropic) helped me plan the scenario, draft the skill and reference files, and write the first version of the tool server and tests. I reviewed and edited the output, ran the tests, and did the Chord setup, deployment and debugging myself. The agent itself runs on Chord.
