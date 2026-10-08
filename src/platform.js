// Jirvs 平台层（v20）：SQLite 持久化 + 账号体系。
// 架构原则不变：Jirvs 只做软件集成，不经手资金、不做合规。
// 资金数据仅为合作机构返回数据的只读呈现；商户真实收款能力需在对应机构完成 KYB。
//
// v20 变更：
//  - 商户/订单/退款全部落 SQLite（data/jirvs.db），重启不丢；
//  - 新增 users（邮箱+密码登录）与 sessions（登录会话）；
//  - 商户归属到 user，一个账号可建多个商户；
//  - 商户 api_key 只存哈希，原值仅创建成功时返回一次；
//  - 商户注册取消"拒绝大陆主体"（v8 老规则作废：法币通道走 Antom，大陆主体可注册）；
//  - 商户选通道：channels = ['fiat'] / ['stablecoin'] / 两者；
//  - 法币通道绑定 Antom 账号（v20 先存直连信息，嵌入式开户待 Antom 商务落地）；
//  - 稳定币通道绑定 NOWPayments（API Key + IPN Secret，加密存储）。

const crypto = require('crypto');
const { openDb } = require('./db');

const genId = (prefix, n = 6) => `${prefix}_${crypto.randomBytes(n).toString('hex')}`;
const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// 密码哈希：scrypt（salt:hash）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

const FINAL = new Set(['succeeded', 'failed', 'canceled', 'expired', 'refunded']);

function createPlatform() {
  const db = openDb();

  // ---------- 账号 ----------
  function createUser({ email, password }) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email 格式不正确');
    if (!password || String(password).length < 6) throw new Error('密码至少 6 位');
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) throw new Error('该邮箱已注册，请直接登录');
    const id = genId('u');
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, email, hashPassword(password), now());
    return { id, email };
  }

  function verifyUser(email, password) {
    email = String(email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !verifyPassword(password, u.password_hash)) throw new Error('邮箱或密码不正确');
    return { id: u.id, email: u.email };
  }

  // v21：修改密码（登录态；验旧密码，新密码至少 6 位）
  function changePassword(user_id, oldPassword, newPassword) {
    if (!user_id) throw new Error('需要登录');
    if (!newPassword || String(newPassword).length < 6) throw new Error('新密码至少 6 位');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
    if (!u) throw new Error('账号不存在');
    if (!verifyPassword(String(oldPassword || ''), u.password_hash)) throw new Error('旧密码不正确');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user_id);
    // 改密后踢掉其他会话（当前会话保留）
    return { ok: true };
  }

  // v21：找回密码——生成重置 token（明文只返回一次，DB 只存哈希，1 小时有效）
  function createPasswordReset(email) {
    email = String(email || '').trim().toLowerCase();
    const u = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    if (!u) return null; // 邮箱不存在也返回 null（调用方统一回“已发送”，防枚举）
    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(sha256(token), u.id, expires_at, now());
    return { token, email: u.email, expires_at };
  }
  // v21：用 token 重设密码（一次有效，过期作废）
  function resetPasswordWithToken(token, newPassword) {
    if (!newPassword || String(newPassword).length < 6) throw new Error('新密码至少 6 位');
    const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(token || '')));
    if (!r || r.used) throw new Error('重置链接无效或已使用');
    if (new Date(r.expires_at).getTime() < Date.now()) throw new Error('重置链接已过期，请重新申请');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), r.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(r.token_hash);
    // 重设后踢掉该账号所有旧会话
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
    return { ok: true };
  }

  function createSession(user_id, ttlHours = 24 * 7) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, user_id, expires_at);
    return { token, expires_at };
  }

  function getSessionUser(token) {
    if (!token) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s || s.expires_at < now()) {
      if (s) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(s.user_id);
    return u || null;
  }

  function deleteSession(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ---------- v21.6：总后台管理员（与商户账号/会话完全隔离） ----------
  // 角色：superadmin（全部权限）/ readonly（只能看，不能执行写操作）
  // 密码哈希沿用与 users 表相同的 scrypt 方案（零第三方依赖）。
  const VALID_ADMIN_ROLES = new Set(['superadmin', 'readonly']);
  function createAdmin({ email, password, role }) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email 格式不正确');
    if (!password || String(password).length < 6) throw new Error('密码至少 6 位');
    if (!VALID_ADMIN_ROLES.has(role)) throw new Error('角色仅支持 superadmin / readonly');
    const exists = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
    if (exists) throw new Error('该管理员邮箱已存在');
    const id = genId('adm');
    db.prepare('INSERT INTO admins (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, hashPassword(password), role, now());
    return { id, email, role };
  }
  function verifyAdmin(email, password) {
    email = String(email || '').trim().toLowerCase();
    const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
    if (!a || !verifyPassword(password, a.password_hash)) throw new Error('邮箱或密码不正确');
    return { id: a.id, email: a.email, role: a.role };
  }
  function listAdmins() {
    return db.prepare('SELECT id, email, role, created_at FROM admins ORDER BY created_at ASC').all();
  }
  function createAdminSession(admin_id, ttlHours = 12) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    db.prepare('INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)')
      .run(token, admin_id, expires_at);
    return { token, expires_at };
  }
  function getAdminSessionAdmin(token) {
    if (!token) return null;
    const s = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
    if (!s || s.expires_at < now()) {
      if (s) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
      return null;
    }
    const a = db.prepare('SELECT id, email, role FROM admins WHERE id = ?').get(s.admin_id);
    return a || null;
  }
  // v21.7: 生态合作伙伴登录（独立会话，与商户/管理员隔离）
  function verifyPartner(email, password) {
    const pt = db.prepare('SELECT * FROM partners WHERE email = ?').get(String(email || '').trim().toLowerCase());
    if (!pt || !pt.password_hash) throw new Error('邮箱或密码不正确');
    if (!verifyPassword(password, pt.password_hash)) throw new Error('邮箱或密码不正确');
    return pt;
  }
  function createPartnerSession(partner_id, ttlHours = 24) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    db.prepare('INSERT INTO partner_sessions (token, partner_id, expires_at) VALUES (?, ?, ?)')
      .run(token, partner_id, expires_at);
    return { token, expires_at };
  }
  function getPartnerSessionPartner(token) {
    if (!token) return null;
    const s = db.prepare('SELECT * FROM partner_sessions WHERE token = ?').get(token);
    if (!s || s.expires_at < now()) {
      if (s) db.prepare('DELETE FROM partner_sessions WHERE token = ?').run(token);
      return null;
    }
    const pt = db.prepare('SELECT id, name, type, email, phone, contract_ver, rate, ref_code, sign_status, contract_no, signed_at FROM partners WHERE id = ?').get(s.partner_id);
    return pt || null;
  }
  function deletePartnerSession(token) {
    if (token) db.prepare('DELETE FROM partner_sessions WHERE token = ?').run(token);
  }
  function deleteAdminSession(token) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  }
  // 新增管理员（v21.7）：超管填邮箱直接建只读账号，密码默认 123456，对方登录后自己改。
  function createAdminDirect({ email, by_email }) {
    const a = createAdmin({ email, password: '123456', role: 'readonly' });
    logAdmin(by_email, 'admin_add', email, 'role=readonly 默认密码');
    return a;
  }
  // 删除管理员（v21.7）：超管专属；不能删自己；同时清掉该管理员的登录会话。
  function deleteAdmin({ id, by_email }) {
    const a = db.prepare('SELECT id, email, role FROM admins WHERE id = ?').get(id);
    if (!a) throw new Error('管理员不存在');
    const me = db.prepare('SELECT id FROM admins WHERE email = ?').get(String(by_email || '').toLowerCase());
    if (me && me.id === a.id) throw new Error('不能删除自己');
    db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(a.id);
    db.prepare('DELETE FROM admins WHERE id = ?').run(a.id);
    logAdmin(by_email, 'admin_del', a.email, '');
    return { ok: true, email: a.email };
  }
  // 管理员自己改密码（v21.7）
  function changeAdminPassword(admin_id, oldPassword, newPassword) {
    const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(admin_id);
    if (!a) throw new Error('管理员不存在');
    if (!verifyPassword(String(oldPassword || ''), a.password_hash)) throw new Error('旧密码不正确');
    if (!newPassword || String(newPassword).length < 6) throw new Error('新密码至少 6 位');
    db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(admin_id);
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), admin_id);
    logAdmin(a.email, 'admin_change_password', a.email, '');
    return { ok: true };
  }
  // 操作日志
  function logAdmin(admin_email, action, target, reason) {
    db.prepare('INSERT INTO admin_logs (admin_email, action, target, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(admin_email || ''), String(action || ''), String(target || ''), String(reason || ''), now());
  }
  function listAdminLogs({ limit } = {}) {
    return db.prepare('SELECT * FROM admin_logs ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 100, 500));
  }
  // 首个超级管理员：启动时若 admins 表为空且环境变量 ADMIN_EMAIL/ADMIN_PASSWORD 已设，则自动创建（密码不写死在代码里）
  function ensureSeedAdmin() {
    const n = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
    if (n > 0) return null;
    const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = String(process.env.ADMIN_PASSWORD || '');
    if (!email || !password) {
      console.log('[admin] admins 表为空且未设置 ADMIN_EMAIL/ADMIN_PASSWORD，跳过首个超级管理员创建');
      return null;
    }
    const a = createAdmin({ email, password, role: 'superadmin' });
    logAdmin(email, 'admin_seed', email, '首个超级管理员（环境变量创建）');
    console.log(`[admin] 已创建首个超级管理员: ${email}`);
    return a;
  }

  // ---------- v21.6：总后台数据 API ----------
  function parseProfileCol(raw) {
    try { const p = JSON.parse(raw || 'null'); if (p && p.status) return p.status; } catch {}
    return 'none';
  }
  // 总览统计
  function adminOverview() {
    const ms = db.prepare('SELECT merchant_id, fiat_profile, stable_profile, status FROM merchants').all();
    let fiatActive = 0, stableActive = 0, frozen = 0;
    for (const m of ms) {
      if (parseProfileCol(m.fiat_profile) === 'active') fiatActive++;
      if (parseProfileCol(m.stable_profile) === 'active') stableActive++;
      if (m.status === 'frozen') frozen++;
    }
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD（UTC；与 created_at 同格式）
    const tOrders = db.prepare(
      "SELECT rail, currency, amount, pay_currency, pay_amount FROM orders WHERE status = 'succeeded' AND substr(created_at, 1, 10) = ?"
    ).all(today);
    const fiatToday = {}, usdtToday = {};
    for (const o of tOrders) {
      if (o.rail === 'stablecoin') {
        const c = String(o.pay_currency || o.currency || '').toUpperCase();
        usdtToday[c] = Math.round(((usdtToday[c] || 0) + Number(o.pay_amount || o.amount || 0)) * 100) / 100;
      } else {
        const c = String(o.currency || '').toLowerCase();
        fiatToday[c] = Math.round(((fiatToday[c] || 0) + Number(o.amount || 0)) * 100) / 100;
      }
    }
    return {
      merchant_total: ms.length,
      fiat_active: fiatActive, fiat_inactive: ms.length - fiatActive,
      stable_active: stableActive, stable_inactive: ms.length - stableActive,
      frozen_count: frozen,
      today_volume_fiat: fiatToday,
      today_volume_stable: usdtToday,
    };
  }
  // 商户列表：?status=active|frozen ?channel=fiat|stablecoin（该通道已开通）
  function adminListMerchants({ status, channel, limit } = {}) {
    const rows = db.prepare('SELECT * FROM merchants ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Number(limit) || 200, 1000));
    return rows
      .map((r) => {
        const m = rowToMerchant(r);
        m.status = r.status;
        delete m.antom; // 管理员看绑定状态即可，敏感字段不下发（rowToMerchant 的 antom 含 client_id 明文）
        return m;
      })
      .filter((m) => {
        if (status && m.status !== status) return false;
        if (channel === 'fiat' && m.channels_state.fiat.status !== 'active') return false;
        if (channel === 'stablecoin' && m.channels_state.stable.status !== 'active') return false;
        return true;
      });
  }
  // 订单列表：q=商户名称/邮箱搜索；range=today|7d|30d|custom；start/end=ISO 日期（custom 用）
  function adminListOrders({ q, range, start, end, status, limit } = {}) {
    let sql = `SELECT o.*, m.company AS m_company, m.personal_name AS m_personal, m.email AS m_email
               FROM orders o LEFT JOIN merchants m ON o.merchant_id = m.merchant_id`;
    const conds = [], vals = [];
    if (q) {
      const like = `%${String(q).trim()}%`;
      conds.push('(m.company LIKE ? OR m.personal_name LIKE ? OR m.email LIKE ? OR o.merchant_id LIKE ?)');
      vals.push(like, like, like, like);
    }
    const day = (d) => d.toISOString().slice(0, 10);
    const todayD = new Date();
    if (range === 'today') {
      conds.push("substr(o.created_at, 1, 10) = ?"); vals.push(day(todayD));
    } else if (range === '7d' || range === '30d') {
      const n = range === '7d' ? 7 : 30;
      const from = new Date(todayD.getTime() - (n - 1) * 86400000);
      conds.push('substr(o.created_at, 1, 10) >= ?'); vals.push(day(from));
    } else if (range === 'custom' && (start || end)) {
      if (start) { conds.push('substr(o.created_at, 1, 10) >= ?'); vals.push(String(start).slice(0, 10)); }
      if (end) { conds.push('substr(o.created_at, 1, 10) <= ?'); vals.push(String(end).slice(0, 10)); }
    }
    if (status) { conds.push('o.status = ?'); vals.push(status); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY o.created_at DESC LIMIT ?';
    vals.push(Math.min(Number(limit) || 100, 1000));
    const orders = db.prepare(sql).all(...vals);
    return { total: orders.length, orders };
  }
  // 分润统计：period=day|month|all|custom（custom 需 start/end）；按通道拆：Antom（法币，按订单币种）/ NOWPayments（稳定币，按 pay_currency）
  // 分润口径：成功订单的 platform_fee 汇总（真实数据；机构返佣费率待商务落地后接入配置）
  function adminProfit({ period, start, end } = {}) {
    const day = (d) => d.toISOString().slice(0, 10);
    const todayD = new Date();
    let cond = '', vals = [];
    if (period === 'day') { cond = "AND substr(created_at, 1, 10) = ?"; vals = [day(todayD)]; }
    else if (period === 'month') { cond = "AND substr(created_at, 1, 7) = ?"; vals = [day(todayD).slice(0, 7)]; }
    else if (period === 'custom' && start && end) {
      cond = "AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?";
      vals = [String(start).slice(0, 10), String(end).slice(0, 10)];
    }
    const rows = db.prepare(
      `SELECT rail, currency, amount, pay_currency, pay_amount, platform_fee FROM orders WHERE status = 'succeeded' ${cond}`
    ).all(...vals);
    const fiat = { volume: {}, commission: {} }, stable = { volume: {}, commission: {} };
    for (const o of rows) {
      const fee = Number(o.platform_fee) || 0;
      if (o.rail === 'stablecoin') {
        const c = String(o.pay_currency || o.currency || '').toUpperCase() || 'USDT';
        stable.volume[c] = Math.round(((stable.volume[c] || 0) + Number(o.pay_amount || o.amount || 0)) * 100) / 100;
        stable.commission[c] = Math.round(((stable.commission[c] || 0) + fee) * 100) / 100;
      } else {
        const c = String(o.currency || '').toLowerCase() || 'cny';
        fiat.volume[c] = Math.round(((fiat.volume[c] || 0) + Number(o.amount || 0)) * 100) / 100;
        fiat.commission[c] = Math.round(((fiat.commission[c] || 0) + fee) * 100) / 100;
      }
    }
    return {
      period: period === 'day' ? 'day' : period === 'month' ? 'month' : period === 'custom' ? 'custom' : 'all',
      range: period === 'custom' ? { start: String(start || '').slice(0, 10), end: String(end || '').slice(0, 10) } : null,
      antom_fiat: fiat,       // 法币通道（Antom）
      nowpayments_stable: stable, // 稳定币通道（NOWPayments）
      note: '分润=成功订单 platform_fee 汇总（真实数据）；机构返佣费率配置待商务落地后接入。',
    };
  }

  // 总后台通知（🔔）：数字全部来自真实数据；前端点开即清零（未读状态只存前端会话内）
  function adminNotifications() {
    const rows = db.prepare('SELECT * FROM merchants').all();
    let unopenedChannels = 0;
    let frozenMerchants = 0;
    for (const r of rows) {
      const m = rowToMerchant(r);
      if (m.channels_state.fiat.status !== 'active') unopenedChannels++;
      if (m.channels_state.stable.status !== 'active') unopenedChannels++;
      if (r.status === 'frozen') frozenMerchants++;
    }
    const failedOrders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'failed'").get().n;
    const items = [];
    if (unopenedChannels > 0) items.push({ key: 'channels', label: '通道接入', text: `${unopenedChannels} 个通道尚未接通，等待商户完成凭证绑定与接口验证` });
    if (failedOrders > 0) items.push({ key: 'orders', label: '异常订单', text: `${failedOrders} 笔订单状态为失败，需核对通道状态或联系商户` });
    if (frozenMerchants > 0) items.push({ key: 'frozen', label: '冻结商户', text: `${frozenMerchants} 个商户处于冻结状态` });
    return { items, unread: items.length };
  }

  // ---------- 商户 ----------
  const VALID_CHANNELS = new Set(['fiat', 'stablecoin']);
  function normalizeChannels(channels) {
    const arr = Array.isArray(channels) ? channels : [channels];
    const out = [...new Set(arr.map((c) => String(c || '').toLowerCase()).filter((c) => VALID_CHANNELS.has(c)))];
    if (!out.length) throw new Error('请至少选择一个收款通道：fiat（法币）或 stablecoin（稳定币）');
    return out;
  }

  // v21.6：注册成功立即自动生成一把 jk_live_ Key 并返回（只存哈希，原值仅返回一次）。
  // 废除 v21.2 的 deferKey 逻辑：不再等通道变绿，商户拿 Key 先填插件，通道另行开通。
  function createMerchant(user_id, { channels, company, personal_name, country, email }) {
    if (!user_id) throw new Error('需要登录');
    const exists = db.prepare('SELECT merchant_id FROM merchants WHERE user_id = ? LIMIT 1').get(user_id);
    if (exists) throw new Error('该账号已完成入驻（一个账号只能创建一个商户）');
    const ch = (channels && channels.length) ? normalizeChannels(channels) : []; // 分通道注册：建记录时可先不带通道
    if (ch.includes('fiat') && !(company && String(company).trim())) throw new Error('法币通道请填写公司名称');
    if (ch.includes('stablecoin') && !(personal_name && String(personal_name).trim())) throw new Error('稳定币通道请填写个人姓名');
    if (!email) throw new Error('email 为必填项');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email 格式不正确');
    const merchant_id = String(email).trim().toLowerCase(); // v21：商户标识就是邮箱，不再生成 mch_xxx
    const api_key = 'jk_live_' + crypto.randomBytes(16).toString('hex');
    const keyHash = sha256(api_key);
    db.prepare(`INSERT INTO merchants
      (merchant_id, user_id, api_key_hash, company, personal_name, country, email, channels, status, key_issued, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`)
      .run(merchant_id, user_id, keyHash,
        String(company || '').trim(), String(personal_name || '').trim(),
        String(country || 'HK').toUpperCase(), String(email), JSON.stringify(ch), now());
    return {
      merchant_id,
      company_name: String(company || '').trim(), personal_name: String(personal_name || '').trim(),
      country: String(country || 'HK').toUpperCase(), email, channels: ch, status: 'active',
      api_key, // 仅注册成功时返回一次，请妥善保存
    };
  }

  // v21.6：分通道注册入口（资料草稿，不断点续传）。注册成功即发 Key（见 createMerchant），
  // 不再等通道变绿；该函数只负责建商户记录+资料草稿。
  function createMerchantDraft(user_id, email) {
    if (!user_id) throw new Error('需要登录');
    const exists = db.prepare('SELECT merchant_id FROM merchants WHERE user_id = ? LIMIT 1').get(user_id);
    if (exists) return { merchant_id: exists.merchant_id, api_key: null }; // 断点续传：Key 早已发过
    const created = createMerchant(user_id, { channels: [], company: '', personal_name: '', country: '', email });
    return { merchant_id: created.merchant_id, api_key: created.api_key };
  }

  // v21：入驻绑定失败时回滚（删掉刚建的商户，不留脏数据）
  function deleteMerchant(merchant_id) {
    db.prepare('DELETE FROM merchants WHERE merchant_id = ?').run(merchant_id);
  }

  // v21：绑定成功后自动把通道追加进商户 channels（已入驻商户可在收款通道页追加开通另一通道）
  function addChannel(merchant_id, channel) {
    if (!VALID_CHANNELS.has(channel)) return;
    const r = db.prepare('SELECT channels FROM merchants WHERE merchant_id = ?').get(merchant_id);
    if (!r) return;
    const ch = JSON.parse(r.channels || '[]');
    if (!ch.includes(channel)) {
      ch.push(channel);
      db.prepare('UPDATE merchants SET channels = ? WHERE merchant_id = ?').run(JSON.stringify(ch), merchant_id);
    }
  }

  // v20：API Key 安全重新生成——仅商户归属账号可操作；旧 Key 立即失效；新 Key 只返回一次，服务端仍只存哈希。
  // v21.6：废除"零 active 拒绝"——Key 注册时已发，轮换随时可做，不再要求通道变绿。
  function rotateMerchantKey(user_id, merchant_id) {
    if (!user_id) throw new Error('需要登录');
    const r = db.prepare('SELECT * FROM merchants WHERE merchant_id = ?').get(merchant_id);
    if (!r) throw new Error('商户不存在: ' + merchant_id);
    if (r.user_id !== user_id) throw new Error('无权操作该商户');
    const api_key = 'jk_live_' + crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE merchants SET api_key_hash = ?, key_issued = 1 WHERE merchant_id = ?').run(sha256(api_key), merchant_id);
    return { merchant_id, api_key }; // 仅本次响应返回，请立即保存；刷新页面后无法再查看
  }

  function nextStepsFor(channels) {
    const steps = ['把 api_key 填进插件或网站后台，即可调用 Jirvs 统一 API（商户零部署）'];
    if (channels.includes('fiat')) {
      steps.push('法币通道：在商户门户直连你的 Antom 账户（大陆/香港主体均可；Antom 嵌入式开户待确认，联调完成后另行通知）');
    }
    if (channels.includes('stablecoin')) {
      steps.push('稳定币通道：去 NOWPayments 官网注册（邮箱即可）→ 添加收款钱包 → 生成 API Key + IPN Secret → 回商户门户绑定；提币在 NOWPayments，Jirvs 只做技术集成');
    }
    return steps;
  }

  function rowToMerchant(r) {
    if (!r) return null;
    const { api_key_hash, company, ...rest } = r;
    // v21.2：两通道状态（公开展示，不含密钥）
    const parseProfile = (raw, isFiat) => {
      try {
        const p = JSON.parse(raw || 'null');
        if (p && typeof p === 'object' && p.status) return p;
      } catch {}
      return isFiat ? { status: 'none', company_name: '', country: '' } : { status: 'none', personal_name: '', country: '' };
    };
    return {
      ...rest,
      company_name: company || '', // v21：对外字段统一叫 company_name（DB 列名仍为 company）
      channels: JSON.parse(rest.channels || '[]'),
      channels_state: {
        fiat: parseProfile(r.fiat_profile, true),
        stable: parseProfile(r.stable_profile, false),
      },
      payoneer: rest.payoneer ? JSON.parse(rest.payoneer) : null,
      antom: rest.antom ? JSON.parse(rest.antom) : null,
      nowpayments: rest.nowpayments ? publicNowPayments(JSON.parse(rest.nowpayments)) : { bound: false, charges_enabled: false },
    };
  }

  function getMerchant(merchant_id) {
    const r = db.prepare('SELECT * FROM merchants WHERE merchant_id = ?').get(merchant_id);
    if (!r) throw new Error('商户不存在: ' + merchant_id);
    return rowToMerchant(r);
  }

  function getMerchantInternal(merchant_id) {
    // 含 api_key_hash，供服务端验签用
    const r = db.prepare('SELECT * FROM merchants WHERE merchant_id = ?').get(merchant_id);
    if (!r) throw new Error('商户不存在: ' + merchant_id);
    return r;
  }

  function verifyApiKey(merchant_id, api_key) {
    try {
      const r = getMerchantInternal(merchant_id);
      if (r.status === 'frozen') return false; // v21.6：冻结商户的 Key 全部失效
      if (!r.api_key_hash) return false;
      return r.api_key_hash === sha256(api_key || '');
    } catch { return false; }
  }

  function listMerchants(user_id) {
    const rows = db.prepare('SELECT * FROM merchants WHERE user_id = ? ORDER BY created_at DESC').all(user_id);
    return rows.map(rowToMerchant);
  }

  function assertOwnMerchant(user_id, merchant_id) {
    const r = db.prepare('SELECT merchant_id FROM merchants WHERE merchant_id = ? AND user_id = ?')
      .get(merchant_id, user_id);
    if (!r) throw new Error('商户不存在或不属于当前账号: ' + merchant_id);
  }

  // v21：追加开通通道时补填公司名 / 个人姓名
  function updateMerchantProfile(merchant_id, { company_name, personal_name } = {}) {
    if (company_name !== undefined) db.prepare('UPDATE merchants SET company = ? WHERE merchant_id = ?').run(String(company_name), merchant_id);
    if (personal_name !== undefined) db.prepare('UPDATE merchants SET personal_name = ? WHERE merchant_id = ?').run(String(personal_name), merchant_id);
  }
  function setMerchantJson(merchant_id, field, obj) {    db.prepare(`UPDATE merchants SET ${field} = ? WHERE merchant_id = ?`)
      .run(JSON.stringify(obj || null), merchant_id);
  }
  function getMerchantJson(merchant_id, field) {
    const r = db.prepare(`SELECT ${field} AS v FROM merchants WHERE merchant_id = ?`).get(merchant_id);
    return r && r.v ? JSON.parse(r.v) : null;
  }

  // 对外呈现的 NOWPayments 绑定信息：只给状态，不给凭证
  function publicNowPayments(b) {
    if (!b) return { bound: false, charges_enabled: false };
    const { api_key_enc, ipn_secret_enc, ...rest } = b;
    return { bound: !!rest.bound, ...rest };
  }

  function setMerchantNowPayments(merchant_id, binding) {
    const b = { ...(binding || {}), updated_at: now() };
    setMerchantJson(merchant_id, 'nowpayments', b);
    return publicNowPayments(b);
  }
  function updateMerchantNowPayments(merchant_id, patch) {
    const cur = getMerchantJson(merchant_id, 'nowpayments') || {};
    const next = { ...cur, ...patch, updated_at: now() };
    setMerchantJson(merchant_id, 'nowpayments', next);
    return publicNowPayments(next);
  }
  function getMerchantNowPaymentsSecrets(merchant_id) {
    const b = getMerchantJson(merchant_id, 'nowpayments');
    if (!b || !b.bound) throw new Error(`商户 ${merchant_id} 未绑定 NOWPayments`);
    return b; // 含 api_key_enc / ipn_secret_enc，由调用方解密
  }

  // 法币通道：Antom 直连信息（v20 先存，Antom 联调后启用；嵌入式开户待商务落地）
  function setMerchantAntom(merchant_id, info) {
    const cur = getMerchantJson(merchant_id, 'antom') || {};
    const next = { ...cur, ...(info || {}), updated_at: now() };
    setMerchantJson(merchant_id, 'antom', next);
    return next;
  }

  // 银行卡（Payoneer 沙盒，待 Antom 替换）
  function setMerchantPayoneer(merchant_id, payoneerInfo) {
    const next = { ...(payoneerInfo || {}), updated_at: now() };
    setMerchantJson(merchant_id, 'payoneer', next);
    return next;
  }
  function updateMerchantPayoneer(merchant_id, patch) {
    const cur = getMerchantJson(merchant_id, 'payoneer') || {};
    const next = { ...cur, ...patch, updated_at: now() };
    setMerchantJson(merchant_id, 'payoneer', next);
    return next;
  }
  function findMerchantByPayoneerAccount(account_id) {
    const rows = db.prepare('SELECT merchant_id, payoneer FROM merchants').all();
    for (const r of rows) {
      try {
        const p = r.payoneer ? JSON.parse(r.payoneer) : null;
        if (p && p.account_id === account_id) return r.merchant_id;
      } catch { /* 忽略坏数据 */ }
    }
    return '';
  }

  // 支付方式展示名
  function railDisplayName({ rail, token, network } = {}) {
    if (String(rail || '').toLowerCase() === 'stablecoin') {
      return token && network ? `稳定币 (${token}·${network})` : '稳定币';
    }
    return '银行卡';
  }

  // ---------- 内部订单 ----------
  function recordOrder(o) {
    if (!o || !o.order_id) return null;
    db.prepare(`INSERT OR REPLACE INTO orders
      (order_id, merchant_id, amount, currency, status, payment_id, gateway, mode, rail,
       description, charge_model, payoneer_account, token, network,
       nowpayments_payment_id, pay_amount, pay_currency, deposit_address, platform_fee,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        o.order_id, o.merchant_id || '', Number(o.amount) || 0, String(o.currency || '').toLowerCase(),
        o.status || 'requires_payment_method', o.payment_id || '', o.gateway || '', o.mode || '',
        o.rail || '', o.description || '', o.charge_model || '', o.payoneer_account || '',
        o.token ? String(o.token).toUpperCase() : '', o.network || '',
        o.nowpayments_payment_id || '',
        o.pay_amount != null ? Number(o.pay_amount) : null,
        o.pay_currency || '', o.deposit_address || '', Number(o.platform_fee) || 0,
        o.created_at || now(), now(),
      );
    return getOrder(o.order_id);
  }

  function updateOrder(order_id, patch) {
    const cur = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(order_id);
    if (!cur) return null;
    if (FINAL.has(cur.status) && patch.status && !FINAL.has(patch.status)) {
      return cur; // 终态订单不再回退
    }
    const keys = ['merchant_id', 'amount', 'currency', 'status', 'payment_id', 'gateway', 'mode',
      'rail', 'description', 'charge_model', 'payoneer_account', 'token', 'network',
      'nowpayments_payment_id', 'pay_amount', 'pay_currency', 'deposit_address', 'platform_fee'];
    const sets = [];
    const vals = [];
    for (const k of keys) {
      if (patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(patch[k]); }
    }
    sets.push('updated_at = ?');
    vals.push(now(), order_id);
    if (sets.length > 1) db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE order_id = ?`).run(...vals);
    return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(order_id);
  }

  function getOrder(order_id) {
    const o = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(order_id);
    if (!o) throw new Error('订单不存在: ' + order_id);
    return o;
  }

  function listOrders({ merchant_id, user_id, status, limit } = {}) {
    let sql = 'SELECT * FROM orders';
    const conds = [];
    const vals = [];
    if (merchant_id) { conds.push('merchant_id = ?'); vals.push(merchant_id); }
    if (user_id) {
      conds.push(`merchant_id IN (SELECT merchant_id FROM merchants WHERE user_id = ?)`);
      vals.push(user_id);
    }
    if (status) { conds.push('status = ?'); vals.push(status); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    vals.push(Math.min(Number(limit) || 50, 200));
    const list = db.prepare(sql).all(...vals);
    return { total: list.length, orders: list };
  }

  function findOrderByPayment(payment_id) {
    return db.prepare('SELECT * FROM orders WHERE payment_id = ? OR nowpayments_payment_id = ? LIMIT 1')
      .get(payment_id, payment_id) || null;
  }

  function recordRefund({ order_id, amount, currency, refund_id }) {
    db.prepare('INSERT INTO refunds (order_id, amount, currency, refund_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(order_id || '', Number(amount) || 0, String(currency || '').toLowerCase(), refund_id || '', now());
  }

  // ---------- 资金视图（只读） ----------
  function fundsOverview(user_id) {
    const list = listOrders({ user_id, limit: 200 }).orders;
    const sumByCcy = (arr) => {
      const m = {};
      for (const o of arr) m[o.currency] = Math.round(((m[o.currency] || 0) + o.amount) * 100) / 100;
      return m;
    };
    const done = list.filter((o) => o.status === 'succeeded');
    const pending = list.filter((o) => !FINAL.has(o.status));
    // v21.6：稳定币没有退款一说——退款只统计法币币种，且只统计本商户自己的订单（按 order_id 关联）
    const rfs = db.prepare(`SELECT r.currency AS currency, SUM(r.amount) AS s FROM refunds r
      JOIN orders o ON o.order_id = r.order_id AND o.order_id != ''
      WHERE o.merchant_id IN (SELECT merchant_id FROM merchants WHERE user_id = ?)
      GROUP BY r.currency`).all(user_id);
    const refundByCcy = {};
    for (const r of rfs) {
      const c = String(r.currency || '').toLowerCase();
      if (c === 'usdt' || c === 'usdc') continue; // 稳定币没有退款一说
      refundByCcy[c] = Math.round(r.s * 100) / 100;
    }
    return {
      mode: 'sandbox',
      order_count: list.length,
      succeeded_count: done.length,
      pending_count: pending.length,
      settled_volume: sumByCcy(done),
      pending_volume: sumByCcy(pending),
      refunded_volume: refundByCcy,
      note: 'Jirvs 不经手资金；真实模式此处展示 Antom / NOWPayments 只读余额与打款记录（NOWPayments 余额只读接口已接，Antom 待联调）。',
    };
  }

  // ---------- v21.2：分通道状态机 ----------
  // profile 结构：fiat { status, company_name, country }；stable { status, personal_name, country }
  // status: none（未注册）| draft（资料已存）| pending（KEY 待验证）| active（已开通/绿勾）
  const blankFiatProfile = () => ({ status: 'none', company_name: '', country: '' });
  const blankStableProfile = () => ({ status: 'none', personal_name: '', country: '' });

  function readProfile(row, channel) {
    const raw = channel === 'fiat' ? row.fiat_profile : row.stable_profile;
    try {
      const p = JSON.parse(raw || 'null');
      if (p && typeof p === 'object' && p.status) return p;
    } catch {}
    return channel === 'fiat' ? blankFiatProfile() : blankStableProfile();
  }

  function writeProfile(merchant_id, channel, profile) {
    const col = channel === 'fiat' ? 'fiat_profile' : 'stable_profile';
    db.prepare(`UPDATE merchants SET ${col} = ? WHERE merchant_id = ?`).run(JSON.stringify(profile), merchant_id);
    syncChannelsFromProfiles(merchant_id);
    return profile;
  }

  // 通道状态变化后同步 channels 数组（向后兼容：有草稿就算入驻过该通道）
  function syncChannelsFromProfiles(merchant_id) {
    const m = getMerchantInternal(merchant_id);
    if (!m) return;
    const f = readProfile(m, 'fiat');
    const s = readProfile(m, 'stable');
    const ch = [];
    if (f.status !== 'none') ch.push('fiat');
    if (s.status !== 'none') ch.push('stablecoin');
    db.prepare('UPDATE merchants SET channels = ? WHERE merchant_id = ?').run(JSON.stringify(ch), merchant_id);
  }

  // 两通道状态（公开展示，无敏感字段）
  function getChannelState(merchant_id) {
    const m = getMerchantInternal(merchant_id);
    if (!m) return null;
    return { fiat: readProfile(m, 'fiat'), stable: readProfile(m, 'stable') };
  }

  // 保存/更新资料草稿：状态 none→draft；已存在则只更新资料，不断点续传
  function saveChannelDraft(merchant_id, channel, { name, country }) {
    const m = getMerchantInternal(merchant_id);
    if (!m) return null;
    const p = readProfile(m, channel);
    if (p.status === 'none') p.status = 'draft';
    if (channel === 'fiat') {
      if (name !== undefined) p.company_name = String(name).slice(0, 120);
      if (country !== undefined) {
        p.country = String(country).toUpperCase().slice(0, 8);
        // v21.7：把 country 同步写回 merchants.country 字段，否则 portal.html 头部展示的仍是建表默认值 'HK'
        db.prepare('UPDATE merchants SET country = ? WHERE merchant_id = ?').run(p.country, merchant_id);
      }
      db.prepare('UPDATE merchants SET company = ? WHERE merchant_id = ?').run(p.company_name, merchant_id);
    } else {
      if (name !== undefined) p.personal_name = String(name).slice(0, 120);
      if (country !== undefined) {
        p.country = String(country).toUpperCase().slice(0, 8);
        // 同上：稳定币通道的 country 也要同步到 merchants.country
        db.prepare('UPDATE merchants SET country = ? WHERE merchant_id = ?').run(p.country, merchant_id);
      }
      db.prepare('UPDATE merchants SET personal_name = ? WHERE merchant_id = ?').run(p.personal_name, merchant_id);
    }
    return writeProfile(merchant_id, channel, p);
  }

  function setChannelStatus(merchant_id, channel, status) {
    const m = getMerchantInternal(merchant_id);
    if (!m) return null;
    const p = readProfile(m, channel);
    p.status = status;
    return writeProfile(merchant_id, channel, p);
  }

  // 通道是否已开通（绿勾）：服务端门禁的唯一依据
  function channelIsActive(merchant_id, channel) {
    const m = getMerchantInternal(merchant_id);
    if (!m) return false;
    return readProfile(m, channel).status === 'active';
  }

  // v21.6：冻结 / 解冻商户。冻结效果：禁止该商户登录门户（登录接口拦截）、
  // 其 jk_live_ Key 全部失效（verifyApiKey 直接返回 false）、当前登录会话被踢掉。
  // 不碰商户自己的 Antom / NOWPayments 账号与资金。每次操作写入 admin_logs。
  function freezeMerchant(merchant_id, { reason, admin_email }) {
    if (!reason || !String(reason).trim()) throw new Error('冻结原因必填');
    const m = getMerchantInternal(merchant_id); // 不存在直接抛错
    db.prepare("UPDATE merchants SET status = 'frozen' WHERE merchant_id = ?").run(merchant_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(m.user_id); // 踢掉该商户当前所有登录
    logAdmin(admin_email, 'freeze', merchant_id, String(reason).trim());
    return { merchant_id, status: 'frozen' };
  }
  function unfreezeMerchant(merchant_id, { admin_email }) {
    getMerchantInternal(merchant_id); // 不存在直接抛错
    db.prepare("UPDATE merchants SET status = 'active' WHERE merchant_id = ?").run(merchant_id);
    logAdmin(admin_email, 'unfreeze', merchant_id, '');
    return { merchant_id, status: 'active' };
  }
  function isMerchantFrozen(merchant_id) {
    try {
      return getMerchantInternal(merchant_id).status === 'frozen';
    } catch { return false; }
  }
  // 该登录账号名下是否有被冻结的商户（登录接口用）
  function isUserFrozen(user_id) {
    const r = db.prepare("SELECT merchant_id FROM merchants WHERE user_id = ? AND status = 'frozen' LIMIT 1").get(user_id);
    return !!r;
  }

  return {
    createUser, verifyUser, changePassword, createPasswordReset, resetPasswordWithToken,
    createSession, getSessionUser, deleteSession,
    createMerchant, createMerchantDraft, deleteMerchant, addChannel, updateMerchantProfile, getMerchant, getMerchantInternal, verifyApiKey, listMerchants, assertOwnMerchant, rotateMerchantKey,
    freezeMerchant, unfreezeMerchant, isMerchantFrozen, isUserFrozen,
    setMerchantNowPayments, updateMerchantNowPayments, getMerchantNowPaymentsSecrets,
    setMerchantAntom, setMerchantPayoneer, updateMerchantPayoneer, findMerchantByPayoneerAccount,
    getChannelState, saveChannelDraft, setChannelStatus, channelIsActive,
    railDisplayName, recordOrder, updateOrder, getOrder, listOrders, findOrderByPayment,
    recordRefund, fundsOverview,
    // v21.6 总后台
    createAdmin, verifyAdmin, listAdmins, createAdminSession, getAdminSessionAdmin, deleteAdminSession,
    verifyPartner, createPartnerSession, getPartnerSessionPartner, deletePartnerSession,
    hashPassword,
    createAdminDirect, deleteAdmin, changeAdminPassword, logAdmin, listAdminLogs, ensureSeedAdmin,
    adminOverview, adminListMerchants, adminListOrders, adminProfit, adminNotifications,
    db, // v21.7 生态合作直接访问
  };
}

module.exports = { createPlatform };
