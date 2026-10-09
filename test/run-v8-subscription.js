// v8 订阅修复专项测试：webhook 订阅激活 / pending 显示 / retry 接口
// 用 stub Stripe，不调真实接口；用内存 SQLite 测 activateSubscription 幂等。
process.env.STRIPE_SECRET_KEY = 'sk_test_v8_only';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_v8';

const { createAdapter } = require('../src/stripeAdapter.js');

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL ' + name); }
};

(async () => {
  const a = createAdapter();

  // ---- 1. parseWebhook 返回 metadata ----
  const sessionObj = {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_test_123',
      amount_total: 29900,
      currency: 'usd',
      client_reference_id: 'sub_abc',
      metadata: { subscription_id: 'sub_abc', merchant_id: 'mch_1' },
    }},
  };
  const raw = JSON.stringify(sessionObj);
  // 先算签名（用 adapter 内部逻辑手算）
  const crypto = require('crypto');
  const t = Math.floor(Date.now() / 1000);
  const payload = `${t}.${raw}`;
  const sig = crypto.createHmac('sha256', 'whsec_test_v8').update(payload).digest('hex');
  const ev = a.parseWebhook(raw, `t=${t},v1=${sig}`);
  ok('parseWebhook 返回 metadata', ev.metadata && ev.metadata.subscription_id === 'sub_abc');
  ok('parseWebhook raw_type 正确', ev.raw_type === 'checkout.session.completed');
  ok('parseWebhook 金额 299', ev.amount === 299);

  const expiredObj = { id: 'evt_test_2', type: 'checkout.session.expired',
    data: { object: { id: 'cs_test_456', metadata: { subscription_id: 'sub_xyz', merchant_id: 'mch_1' } } } };
  const raw2 = JSON.stringify(expiredObj);
  const payload2 = `${t}.${raw2}`;
  const sig2 = crypto.createHmac('sha256', 'whsec_test_v8').update(payload2).digest('hex');
  const ev2 = a.parseWebhook(raw2, `t=${t},v1=${sig2}`);
  ok('expired 事件带 subscription_id', ev2.metadata.subscription_id === 'sub_xyz');
  ok('expired 解析为 canceled', ev2.status === 'canceled');

  // ---- 2. activateSubscription 幂等（内存 SQLite）----
  let Database;
  try { Database = require('better-sqlite3'); }
  catch { console.log('  - 跳过 DB 测试（无 better-sqlite3）'); Database = null; }
  if (Database) {
    const eco = require('../src/ecosystem.js');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, merchant_id TEXT, plan TEXT, amount REAL, currency TEXT, status TEXT, paid_at TEXT, expires_at TEXT, referral_code TEXT, stripe_session_id TEXT, payment_id TEXT, created_at TEXT);
             CREATE TABLE subscription_webhook_events (event_id TEXT PRIMARY KEY, received_at TEXT);
             CREATE TABLE commissions (id TEXT PRIMARY KEY, partner_id TEXT, subscription_id TEXT, merchant_id TEXT, amount REAL, rate REAL, status TEXT, created_at TEXT, paid_at TEXT);
             CREATE TABLE partners (id TEXT PRIMARY KEY, ref_code TEXT);`);
    db.prepare(`INSERT INTO subscriptions VALUES ('sub_abc','mch_1','lifetime',299,'USD','pending','','','','','2026-10-09 22:00:00')`).run();
    const r1 = eco.activateSubscription(db, { subscriptionId: 'sub_abc', paymentId: 'cs_test_123', amount: 299, currency: 'USD', eventId: 'stripe:evt_test_1' });
    ok('首次激活成功', r1.ok && r1.status === 'active');
    const r2 = eco.activateSubscription(db, { subscriptionId: 'sub_abc', paymentId: 'cs_test_123', amount: 299, currency: 'USD', eventId: 'stripe:evt_test_1' });
    ok('重复 webhook 幂等（deduped）', r2.ok && r2.deduped);
    const st = db.prepare(`SELECT status FROM subscriptions WHERE id='sub_abc'`).get();
    ok('DB 状态为 active', st.status === 'active');
    // 金额不对拒绝
    db.prepare(`INSERT INTO subscriptions VALUES ('sub_bad','mch_1','lifetime',299,'USD','pending','','','','','2026-10-09 22:00:00')`).run();
    let threw = false;
    try { eco.activateSubscription(db, { subscriptionId: 'sub_bad', paymentId: 'cs_x', amount: 199, currency: 'USD', eventId: 'stripe:evt_bad' }); }
    catch (e) { threw = /金额/.test(e.message); }
    ok('金额不一致拒绝激活', threw);
  }

  // ---- 3. 前端 portal.html 检查 ----
  const fs = require('fs');
  const html = fs.readFileSync(__dirname + '/../public/portal.html', 'utf8');
  ok('openSub 用 st===pending 判断', html.includes("acct.sub.st === 'pending'"));
  ok('无残留 acct.sub.pending 误用', !html.split('\n').some(l => /acct\.sub\.pending/.test(l.split('//')[0])));
  ok('有 retrySub 函数', html.includes('function retrySub'));
  ok('有 subRetryBtn 按钮', html.includes('id="subRetryBtn"'));
  ok('retry 调 /api/v1/subscriptions/retry', html.includes('/api/v1/subscriptions/retry'));

  // ---- 4. server.js 检查 ----
  const srv = fs.readFileSync(__dirname + '/../src/server.js', 'utf8');
  ok('webhook 有订阅分支', srv.includes("event.metadata.subscription_id"));
  ok('webhook 调 activateSubscription', srv.includes('kind: \'subscription\''));
  ok('expired 标 expired', srv.includes("status = 'expired' WHERE id = ?"));
  ok('有 retry 接口', srv.includes("app.post('/api/v1/subscriptions/retry'"));
  ok('retry 作废旧 pending', srv.includes("status = 'canceled' WHERE id = ? AND status = 'pending'"));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e.message); process.exit(1); });
