// v21.7 生态合作（2026-10-07 重构版）
// - $199 终身使用，一次付清，无月付/年付
// - V1 生态合作伙伴：30% 一次性返佣
// - V2 战略合作伙伴：50% 一次性返佣，特邀制（注册不可见，后台改成才是）
// - 签哪个拿哪个，一次性
// - 佣金实时结算，每月5号自动打上个月的
// - 无打款休眠、无自动解约、无佣金冻结

const crypto = require('crypto');

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function nowBJ() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// 根据合同版本取费率：V1=30%, V2=50%
function rateFor(contractVer) {
  return contractVer === 'V2' ? 50 : 30;
}

// 订阅付款成功后调用：产生一次性佣金
function onSubscriptionPaid(db, sub) {
  // sub: {id, merchant_id, amount}
  const m = db.prepare('SELECT partner_id FROM merchants WHERE merchant_id = ?').get(sub.merchant_id);
  if (!m || !m.partner_id) return null;
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(m.partner_id);
  if (!p || p.sign_status !== 'signed') return null;

  const existing = db.prepare('SELECT id, amount, rate, status FROM commissions WHERE subscription_id = ? LIMIT 1').get(sub.id);
  if (existing) return { ...existing, deduped: true };
  const rate = rateFor(p.contract_ver);
  const amount = Math.round(sub.amount * rate) / 100;

  const id = uid('comm');
  db.prepare(`INSERT INTO commissions
    (id, partner_id, merchant_id, subscription_id, amount, rate, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, p.id, sub.merchant_id, sub.id, amount, rate, nowBJ());

  return { id, amount, rate, status: 'pending' };
}

// 只允许由验签后的支付回调调用：pending -> active，且重复回调安全返回。
function activateSubscription(db, { subscriptionId, paymentId, amount, currency = 'USD', eventId }) {
  if (!subscriptionId || !paymentId) throw new Error('subscription_id 与 payment_id 必填');
  if (eventId) {
    const seen = db.prepare('SELECT event_id FROM subscription_webhook_events WHERE event_id = ?').get(eventId);
    if (seen) return { ok: true, deduped: true, status: 'active' };
  }
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
  if (!sub) throw new Error('订阅不存在');
  if (sub.currency !== currency) throw new Error('支付币种与订阅币种不一致');
  if (Number(sub.amount) !== Number(amount)) throw new Error('支付金额与订阅金额不一致');
  if (sub.status === 'active') return { ok: true, deduped: true, status: 'active', id: sub.id };
  if (sub.status !== 'pending') throw new Error(`订阅状态不可激活：${sub.status}`);
  const paidAt = nowBJ();
  db.prepare(`UPDATE subscriptions SET status = 'active', paid_at = ?, payment_id = ? WHERE id = ? AND status = 'pending'`)
    .run(paidAt, String(paymentId), sub.id);
  const updated = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id);
  const commission = onSubscriptionPaid(db, updated);
  if (eventId) db.prepare('INSERT INTO subscription_webhook_events (event_id, received_at) VALUES (?, ?)').run(eventId, paidAt);
  return { ok: true, id: sub.id, status: updated.status, commission };
}

// 每月5号执行：打上个月的所有待打款佣金
function runMonthlyPayout(db, partnerId, yearMonth) {
  // yearMonth: 'YYYY-MM'
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId);
  if (!p) return null;

  const comms = db.prepare(
    `SELECT * FROM commissions
     WHERE partner_id = ? AND status = 'pending'
     AND substr(created_at, 1, 7) = ?`
  ).all(partnerId, yearMonth);
  if (!comms.length) return null;

  const total = comms.reduce((s, c) => s + c.amount, 0);
  const fee = 1.2;
  const net = Math.max(0, Math.round((total - fee) * 100) / 100);

  const payoutId = uid('payout');
  db.prepare(`INSERT INTO payouts
    (id, partner_id, amount, fee, net_amount, status, batch_date, items, created_at)
    VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?)`)
    .run(payoutId, partnerId, total, fee, net, yearMonth,
      JSON.stringify(comms.map(c => c.id)), nowBJ());

  const ids = comms.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE commissions SET status = 'paid', paid_at = ? WHERE id IN (${placeholders})`)
    .run(nowBJ(), ...ids);

  return { id: payoutId, amount: total, fee, net_amount: net, count: comms.length };
}

// 伙伴汇总
function partnerSummary(db, partnerId) {
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId);
  if (!p) return null;
  const row = (st) => db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM commissions WHERE partner_id = ? AND status = ?`
  ).get(partnerId, st);
  const pending = row('pending'), paid = row('paid');
  return {
    partner: p,
    pending: pending.s, pendingCount: pending.c,
    paid: paid.s, paidCount: paid.c,
  };
}

module.exports = {
  uid, nowBJ, rateFor,
  onSubscriptionPaid, activateSubscription, runMonthlyPayout, partnerSummary,
};
