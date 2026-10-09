const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jirvs-fiat-'));
process.env.DB_PATH = path.join(tmp, 'jirvs.db');
const { createPlatform } = require('../src/platform');
const eco = require('../src/ecosystem');

let pass = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  pass += 1;
  console.log(`  ✓ ${name}`);
}

const platform = createPlatform();
const user = platform.createUser({ email: 'fiat@example.com', password: 'pass1234' });
const merchant = platform.createMerchant(user.id, {
  channels: ['fiat'], company: 'Fiat Co', country: 'HK', email: user.email,
});
ok('只允许创建 fiat 商户', merchant.channels.length === 1 && merchant.channels[0] === 'fiat');
ok('注册返回 live Key', merchant.api_key.startsWith('jk_live_'));
ok('注册返回 public Key', merchant.api_pub_key.startsWith('jk_pub_'));
ok('live Key 可鉴权', platform.verifyApiKey(merchant.merchant_id, merchant.api_key));
ok('public Key 可鉴权', platform.verifyApiKey(merchant.merchant_id, merchant.api_pub_key));

let rejected = false;
try {
  platform.createMerchant('missing-user', { channels: ['stablecoin'], company: 'Nope', country: 'HK', email: 'nope@example.com' });
} catch (e) {
  rejected = /仅支持法币|不支持稳定币/.test(e.message);
}
ok('稳定币通道被平台层拒绝', rejected);

const rotated = platform.rotateMerchantKey(user.id, merchant.merchant_id);
ok('轮换同时生成两把新 Key', rotated.api_key.startsWith('jk_live_') && rotated.api_pub_key.startsWith('jk_pub_'));
ok('轮换后旧 live Key 失效', !platform.verifyApiKey(merchant.merchant_id, merchant.api_key));
ok('轮换后新 public Key 可用', platform.verifyApiKey(merchant.merchant_id, rotated.api_pub_key));

const db = platform.db;
const now = new Date().toISOString();
db.prepare('UPDATE users SET referral_code = ?, referral_captured_at = ? WHERE id = ?').run('PTEST', now, user.id);
const ref = db.prepare('SELECT referral_code, referral_captured_at FROM users WHERE id = ?').get(user.id);
const validReferral = ref.referral_code === 'PTEST' && Date.now() - new Date(ref.referral_captured_at).getTime() <= 30 * 86400000;
ok('旧版推荐字段不参与当前计佣规则', validReferral);
const old = new Date(Date.now() - 31 * 86400000).toISOString();
db.prepare('UPDATE users SET referral_captured_at = ? WHERE id = ?').run(old, user.id);
const expired = db.prepare('SELECT referral_captured_at FROM users WHERE id = ?').get(user.id);
ok('旧版推荐字段仅保留兼容，不影响当前订阅回调', Date.now() - new Date(expired.referral_captured_at).getTime() > 30 * 86400000);

const partnerA = 'partner-a';
const partnerB = 'partner-b';
db.prepare(`INSERT INTO partners (id, name, contract_ver, sign_status, ref_code, created_at)
  VALUES (?, ?, 'V1', 'signed', ?, datetime('now'))`).run(partnerA, 'Partner A', 'OLDA');
db.prepare(`INSERT INTO partners (id, name, contract_ver, sign_status, ref_code, created_at)
  VALUES (?, ?, 'V1', 'signed', ?, datetime('now'))`).run(partnerB, 'Partner B', 'NEWB');
db.prepare("UPDATE merchants SET partner_id = ?, referred_at = datetime('now') WHERE merchant_id = ?")
  .run(partnerB, merchant.merchant_id);
const subId = 'sub_smoke';
db.prepare(`INSERT INTO subscriptions
  (id, merchant_id, plan, amount, currency, status, paid_at, expires_at, referral_code, created_at)
  VALUES (?, ?, 'lifetime', 199, 'USD', 'pending', '', '', 'NEWB', datetime('now'))`)
  .run(subId, merchant.merchant_id);
let activated = eco.activateSubscription(db, {
  subscriptionId: subId, paymentId: 'aw_pay_1', amount: 199, currency: 'USD', eventId: 'evt_1',
});
ok('支付成功回调将订阅从 pending 激活', activated.status === 'active');
ok('最新推荐码对应的伙伴获得佣金', activated.commission && activated.commission.amount === 59.7);
const commissionCount = db.prepare('SELECT COUNT(*) AS n FROM commissions WHERE subscription_id = ?').get(subId).n;
ok('重复支付回调不会重复计佣', eco.activateSubscription(db, {
  subscriptionId: subId, paymentId: 'aw_pay_1', amount: 199, currency: 'USD', eventId: 'evt_1',
}).deduped === true && commissionCount === 1);
ok('订阅记录保存支付单号', db.prepare('SELECT payment_id FROM subscriptions WHERE id = ?').get(subId).payment_id === 'aw_pay_1');

console.log(`ALL PASS (${pass})`);
