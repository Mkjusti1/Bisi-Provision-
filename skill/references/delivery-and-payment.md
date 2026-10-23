# Delivery and payment rules

## Delivery
- Lagos only.
- Zones: Mainland ₦5,000, Island ₦8,000. Use `get_delivery_fee` for the exact fee.
- Free delivery on Mainland orders of ₦150,000 or more (items subtotal). The tool applies this; confirm the fee it returns.
- Minimum order: ₦20,000 items subtotal. Below that, tell the customer the minimum and offer to add items.
- Orders paid before 2:00pm (Lagos time) on a trading day are delivered the next trading day. Paid after 2:00pm or on a Sunday: delivered the trading day after. Use the delivery estimate returned by `verify_payment`; do not work it out yourself.
- If the zone is unclear, ask. If the address is outside Lagos, hand over to Bisi.

## Payment
- Payment is only by Paystack link. No transfers to personal accounts, no cash on delivery, no credit.
- The link and stock reservation last 30 minutes from the moment the order is created.
- If the customer has not paid after about 15 minutes, send one friendly reminder with the time left.
- After 30 minutes unpaid, call `release_order` and tell the customer the order expired and the stock was released. Offer to start again.

## When payment fails
- First failure: explain briefly, offer a fresh payment link (`create_order` again only if the old order expired or was released; otherwise reuse the existing order and link while it is still valid).
- Second failure: offer one more fresh link.
- Third failure, or the customer says they were debited but `verify_payment` shows not paid: do not retry. Hand over to Bisi with the order ID (see references/escalation.md). Tell the customer not to pay again.

## Prices and totals
- Totals always come from `create_order`. Do not calculate and quote a total yourself, except as a rough preview before the customer confirms (label it "estimated").
