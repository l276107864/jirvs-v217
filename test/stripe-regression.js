const assert = require('assert');
const crypto = require('crypto');

process.env.STRIPE_SECRET_KEY = 'sk_test_regression';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_regression';
const { createAdapter, minorAmount } = require('../src/stripeAdapter');
const stripe = createAdapter();

function signed(raw) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${t}.${raw}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

const unpaid = JSON.stringify({
  id: 'evt_unpaid', type: 'checkout.session.completed',
  data: { object: { id: 'cs_unpaid', payment_status: 'unpaid', amount_total: 19900, currency: 'usd', metadata: { order_id: 'wc_1' } } },
});
const unpaidEvent = stripe.parseWebhook(unpaid, signed(unpaid));
assert.strictEqual(unpaidEvent.ignored, true);
assert.strictEqual(unpaidEvent.status, 'processing');

const paid = JSON.stringify({
  id: 'evt_paid', type: 'checkout.session.completed',
  data: { object: { id: 'cs_paid', payment_status: 'paid', amount_total: 19900, currency: 'usd', metadata: { order_id: 'wc_2' } } },
});
const paidEvent = stripe.parseWebhook(paid, signed(paid));
assert.strictEqual(paidEvent.status, 'succeeded');
assert.strictEqual(paidEvent.amount_minor, 19900);
assert.strictEqual(minorAmount(199, 'USD'), 19900);
assert.strictEqual(minorAmount(199, 'JPY'), 199);

console.log('STRIPE REGRESSION PASS (4)');
