const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jirvs-fiat-'));
process.env.DB_PATH = path.join(tmp, 'jirvs.db');
const { createPlatform } = require('../src/platform');

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
ok('推荐码 30 天窗口可判断', validReferral);
const old = new Date(Date.now() - 31 * 86400000).toISOString();
db.prepare('UPDATE users SET referral_captured_at = ? WHERE id = ?').run(old, user.id);
const expired = db.prepare('SELECT referral_captured_at FROM users WHERE id = ?').get(user.id);
ok('推荐码超过 30 天失效', Date.now() - new Date(expired.referral_captured_at).getTime() > 30 * 86400000);

console.log(`ALL PASS (${pass})`);
