// v21.7 种子数据：将演示 mock 数据写入真实 SQLite
// 用法：node seed-v21.7.js
// 注意：会清空 partners/merchants/subscriptions/commissions/payouts 表
const fs = require('fs');
const path = require('path');
const { openDb } = require('./src/db');
const eco = require('./src/ecosystem');

const html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');

function extractArray(name) {
  const m = html.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
  if (!m) throw new Error('找不到 ' + name);
  return m[1];
}

// 简单解析 JS 对象字面量（演示数据格式规整，支持一层嵌套如 sub:{st:'x'}）
function parseObjects(src) {
  const objs = [];
  // 匹配 { ... } 允许一层嵌套的 {...}
  const re = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[0].slice(1, -1);
    const o = {};
    const kvRe = /(\w+):('(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|true|false|\{[^{}]*\})/g;
    let kv;
    while ((kv = kvRe.exec(body)) !== null) {
      let v = kv[2];
      if (v.startsWith("'")) v = v.slice(1, -1);
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (v.startsWith('{')) { /* 嵌套对象跳过，后面单独处理 */ }
      else v = Number(v);
      if (!v.toString().startsWith('{')) o[kv[1]] = v;
    }
    const subM = body.match(/sub:\{st:'([^']+)'/);
    if (subM) o._subSt = subM[1];
    if (o.id || o.email) objs.push(o);
  }
  return objs;
}

async function main() {
  const db = openDb();

  // 清空（按依赖顺序）
  for (const t of ['payouts', 'commissions', 'subscriptions', 'merchants', 'partners']) {
    try { db.exec(`DELETE FROM ${t}`); } catch (e) { console.log('清空', t, '跳过:', e.message); }
  }

  // 1. Partners
  const pObjs = parseObjects(extractArray('PARTNERS'));
  console.log('Partners:', pObjs.length);
  const now = eco.nowBJ();
  for (const p of pObjs) {
    const cver = p.contractVer || 'V1';
    // v21.7: rate 字段即合同比例；旧 rate_monthly/rate_yearly 保留兼容
    const rate = p.rate || (cver === 'V2' ? 50 : 30);
    db.prepare(`INSERT INTO partners
      (id, name, type, phone, legal_name, bank_account, credit_code, sign_status,
       rate_monthly, rate_yearly, contract_no, signed_at, sign_ip, contract_ver, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.name, p.type === '企业' ? 'company' : 'personal',
        p.phone || '', p.legal || '', p.bank || '', p.credit || '',
        p.sign === 'signed' ? 'signed' : 'unsigned',
        20, 30, p.recordNo || '', p.signTime || '', '', cver, now);
  }

  // 2. Merchants（FM）
  const fObjs = parseObjects(extractArray('FM'));
  console.log('Merchants:', fObjs.length);
  const emailToMid = {};
  for (const fm of fObjs) {
    const mid = fm.id;
    emailToMid[fm.email] = mid;
    // channels: 根据 antom/airwallex 字段构造
    const channels = [];
    if (fm.antom === 'active' || fm.airwallex === 'active') channels.push('fiat');
    const fiatProfile = (fm.antom === 'active' || fm.airwallex === 'active')
      ? JSON.stringify({ status: 'active' }) : null;
    db.prepare(`INSERT INTO merchants
      (merchant_id, user_id, api_key_hash, company, email, channels, status,
       fiat_profile, partner_id, referred_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mid, 'seed-user', 'seed', fm.name, fm.email, JSON.stringify(channels),
        fm.frozen ? 'frozen' : 'active', fiatProfile,
        fm.pid || '', fm.pid ? now : '', now);
  }

  // 3. Subscriptions（SUBS）+ 真实佣金逻辑
  const sObjs = parseObjects(extractArray('SUBS'));
  console.log('Subscriptions:', sObjs.length);
  let commCount = 0;
  for (const s of sObjs) {
    const mid = emailToMid[s.email];
    if (!mid) continue;
    const id = eco.uid('sub');
    const paidAt = (s.paidAt || now).slice(0, 19);
    // 终身：expires_at 设为 2099
    db.prepare(`INSERT INTO subscriptions
      (id, merchant_id, plan, amount, currency, status, paid_at, expires_at, created_at)
      VALUES (?,?,?,?,?,'active',?,'2099-12-31 23:59:59',?)`)
      .run(id, mid, 'lifetime', s.amount || 199, 'USD', paidAt, now);
    // 真实佣金逻辑
    const comm = eco.onSubscriptionPaid(db, { id, merchant_id: mid, amount: s.amount || 199 });
    if (comm) commCount++;
  }
  console.log('Commissions generated:', commCount);

  // 4. 汇总
  const pc = db.prepare('SELECT COUNT(*) n FROM partners').get().n;
  const mc = db.prepare('SELECT COUNT(*) n FROM merchants').get().n;
  const sc = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
  const cc = db.prepare('SELECT COUNT(*) n FROM commissions').get().n;
  const sum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM commissions').get().s;
  console.log(`\n完成: partners=${pc} merchants=${mc} subscriptions=${sc} commissions=${cc} total=$${sum}`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
