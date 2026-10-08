// v20: SQLite 持久层（Node 24 内置 node:sqlite，零第三方依赖）。
// 数据文件：./data/jirvs.db（可由环境变量 DB_PATH 覆盖）。
// 表：users（登录账号）、sessions（登录会话）、merchants（商户，归属 user）、
//     orders（内部订单）、refunds（退款记录）。

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

function openDb() {
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jirvs.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merchants (
      merchant_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      company TEXT DEFAULT '',
      country TEXT DEFAULT 'HK',
      contact TEXT DEFAULT '',
      email TEXT DEFAULT '',
      channels TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      payoneer TEXT DEFAULT NULL,
      antom TEXT DEFAULT NULL,
      nowpayments TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      merchant_id TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      currency TEXT DEFAULT '',
      status TEXT DEFAULT '',
      payment_id TEXT DEFAULT '',
      gateway TEXT DEFAULT '',
      mode TEXT DEFAULT '',
      rail TEXT DEFAULT '',
      description TEXT DEFAULT '',
      charge_model TEXT DEFAULT '',
      payoneer_account TEXT DEFAULT '',
      token TEXT DEFAULT '',
      network TEXT DEFAULT '',
      nowpayments_payment_id TEXT DEFAULT '',
      pay_amount REAL DEFAULT NULL,
      pay_currency TEXT DEFAULT '',
      deposit_address TEXT DEFAULT '',
      platform_fee REAL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      currency TEXT DEFAULT '',
      refund_id TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  // v21: 稳定币通道个人姓名（法币通道用 company 存公司名）；老库升级加列
  try { db.exec(`ALTER TABLE merchants ADD COLUMN personal_name TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
  // v21: 找回密码 token 表（只存 token 的 SHA-256 哈希）
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  // v21.2：分通道独立注册状态。status: none（未注册）| draft（资料已存）| pending（KEY 待验证）| active（已开通/绿勾）
  // fiat_profile:    { status, company_name, country }
  // stable_profile:  { status, personal_name, country }
  try { db.exec(`ALTER TABLE merchants ADD COLUMN fiat_profile TEXT DEFAULT NULL`); } catch { /* 列已存在 */ }
  try { db.exec(`ALTER TABLE merchants ADD COLUMN stable_profile TEXT DEFAULT NULL`); } catch { /* 列已存在 */ }
  // v21.2：一账号只有一把 Jirvs KEY。key_issued=1 表示已发放（首绿时发放），0 表示还没发。
  try { db.exec(`ALTER TABLE merchants ADD COLUMN key_issued INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }
  // v21.2：老数据迁移——从 company/personal_name/channels/payoneer/antom/nowpayments 推导通道 profile
  try {
    const rows = db.prepare('SELECT * FROM merchants WHERE fiat_profile IS NULL OR stable_profile IS NULL').all();
    for (const m of rows) {
      const channels = JSON.parse(m.channels || '[]');
      let payoneer = null, antom = null, nowp = null;
      try { payoneer = JSON.parse(m.payoneer || 'null'); } catch {}
      try { antom = JSON.parse(m.antom || 'null'); } catch {}
      try { nowp = JSON.parse(m.nowpayments || 'null'); } catch {}
      // 法币：Antom 真实联调通过才算绿；老 Payoneer 沙盒模拟只算待验证（pending），不算绿
      const fiatActive = channels.includes('fiat') && antom && antom.live === true;
      const fiatPending = !fiatActive && (channels.includes('fiat') || m.company) &&
        ((payoneer && payoneer.charges_enabled) || (antom && !antom.live));
      const stableActive = channels.includes('stablecoin') && nowp && nowp.bound;
      const fiat = {
        status: fiatActive ? 'active' : (fiatPending ? 'pending' : (m.company ? 'draft' : 'none')),
        company_name: m.company || '', country: m.country || '',
      };
      const stable = {
        status: stableActive ? 'active' : (m.personal_name ? 'draft' : 'none'),
        personal_name: m.personal_name || '', country: '',
      };
      const keyIssued = (m.api_key_hash && m.api_key_hash.length > 8) ? 1 : 0;
      db.prepare('UPDATE merchants SET fiat_profile = ?, stable_profile = ?, key_issued = ? WHERE merchant_id = ?')
        .run(JSON.stringify(fiat), JSON.stringify(stable), keyIssued, m.merchant_id);
    }
  } catch (e) { console.error('[db] v21.2 migration failed:', e.message); }
  // v21.6：总后台管理员独立账号体系（与商户 users/sessions 完全隔离）
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'readonly',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_email TEXT DEFAULT '',
      action TEXT DEFAULT '',
      target TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  // v21.7：订阅（商户向 Jirvs 付费：$29.9/月、$199/年）
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'monthly',
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'active',
      paid_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sub_merchant ON subscriptions(merchant_id);
    CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions(status);
  `);
  // v21.7：生态合作伙伴
  db.exec(`
    CREATE TABLE IF NOT EXISTS partners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'personal',
      phone TEXT DEFAULT '',
      legal_name TEXT DEFAULT '',
      bank_account TEXT DEFAULT '',
      credit_code TEXT DEFAULT '',
      sign_status TEXT NOT NULL DEFAULT 'unsigned',
      rate_monthly INTEGER NOT NULL DEFAULT 20,
      rate_yearly INTEGER NOT NULL DEFAULT 30,
      contract_no TEXT DEFAULT '',
      signed_at TEXT DEFAULT '',
      sign_ip TEXT DEFAULT '',
      contract_ver TEXT NOT NULL DEFAULT 'V1',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commissions (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      rate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      batch_date TEXT DEFAULT '',
      paid_at TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comm_partner ON commissions(partner_id);
    CREATE INDEX IF NOT EXISTS idx_comm_status ON commissions(status);
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      fee REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      batch_date TEXT NOT NULL,
      items TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payout_partner ON payouts(partner_id);
  `);
  // v21.7：商户推荐归因（partner_id 为空表示自然注册）
  try { db.exec(`ALTER TABLE merchants ADD COLUMN partner_id TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
  try { db.exec(`ALTER TABLE merchants ADD COLUMN referred_at TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
  return db;
}

module.exports = { openDb };
