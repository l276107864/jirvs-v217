// v21.6 自动测试：注册即发 Key + 冻结/解冻 + 总后台管理员体系 + 管理员数据 API
// 跑法：npm test（自动起临时服务 + 临时数据库，不污染正式数据；NOWPayments 走内存模拟不碰网络；邮件走 dev 日志不真发）
// 废除的旧规则（不再断言）：注册不发 Key、零 active 禁止生成/轮换 Key、首绿才发 Key
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { signIpn } = require('../src/nowpaymentsAdapter');

const PORT = 13458;
const TMPD = fs.mkdtempSync(path.join(os.tmpdir(), 'v22test-'));
const DB = path.join(TMPD, 't.db');
const ROOT = path.join(__dirname, '..');

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'boss@example.com';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.error('请先设置环境变量 TEST_ADMIN_PASSWORD 再跑测试，例如：');
  console.error('  TEST_ADMIN_PASSWORD=你设的密码 npm test');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

function req({ method = 'GET', path: p, body, headers = {}, cookieJar }) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'content-type': 'application/json', ...headers },
    };
    if (cookieJar && cookieJar.cookie) opts.headers.cookie = cookieJar.cookie;
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length && cookieJar) {
          cookieJar.cookie = sc.map((s) => s.split(';')[0]).join('; ');
        }
        let json = null;
        try { json = JSON.parse(data); } catch { /* html */ }
        resolve({ status: res.statusCode, json, text: data, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

let serverOut = '';
function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env, PORT: String(PORT), DB_PATH: DB, NOWPAYMENTS_MOCK: 'true',
      ADMIN_EMAIL, ADMIN_PASSWORD,
    };
    delete env.RESEND_API_KEY;
    const child = spawn('node', [path.join(ROOT, 'src/server.js')], { env, stdio: 'pipe' });
    child.stdout.on('data', (d) => { serverOut += d; if (/已启动/.test(serverOut)) resolve(child); });
    child.stderr.on('data', (d) => { serverOut += d; });
    setTimeout(() => reject(new Error('server start timeout: ' + serverOut.slice(0, 500))), 15000);
  });
}
const kill = (child) => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); setTimeout(r, 3000); });
const newJar = () => ({ cookie: '' });
async function registerLogin(email, password) {
  const jar = newJar();
  const r = await req({ method: 'POST', path: '/api/v1/auth/register', body: { email, password }, cookieJar: jar });
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.json));
  return jar;
}
async function adminLogin(email, password) {
  const jar = newJar();
  const r = await req({ method: 'POST', path: '/api/admin/login', body: { email, password }, cookieJar: jar });
  if (r.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(r.json));
  return jar;
}

(async () => {
  console.log('== v21.6 自动测试 ==');
  const child = await startServer();

  try {
    // ---------- 注册即发 Key ----------
    console.log('注册即发 Key');
    const jar = await registerLogin('v22a@example.com', 'pass1234');
    let r = await req({ method: 'POST', path: '/api/v1/merchants', body: { channel: 'fiat', name: '测试有限公司', country: 'CN' }, cookieJar: jar });
    ok('法币通道注册成功', r.status === 200 && r.json.status === 'draft', JSON.stringify(r.json).slice(0, 120));
    ok('注册成功立即返回 Jirvs KEY', r.status === 200 && typeof r.json.api_key === 'string' && r.json.api_key.startsWith('jk_live_'));
    const mid = r.json.merchant_id;
    const apiKey = r.json.api_key;
    ok('商户标识为登录邮箱', mid === 'v22a@example.com', mid);

    // 断点续传：第二个通道注册不再重复发 Key
    r = await req({ method: 'POST', path: '/api/v1/merchants', body: { channel: 'stablecoin', name: '张三', country: 'HK' }, cookieJar: jar });
    ok('第二通道注册成功（断点续传）', r.status === 200 && r.json.merchant_id === mid);
    ok('断点续传不再重复发 Key', r.status === 200 && !('api_key' in r.json));

    // Key 立即可用（不需要等绿勾）
    r = await req({ path: '/api/v1/orders', headers: { 'x-api-key': apiKey }, cookieJar: null });
    // /api/v1/orders 需要登录会话，这里用 Key 调一个需要 Key 的接口验证：建单鉴权通过但通道未开通
    r = await req({ method: 'POST', path: '/api/v1/checkout/sessions',
      body: { merchant_id: mid, order_id: 'k1', amount: 10, currency: 'usd' }, headers: { 'x-api-key': apiKey } });
    ok('Key 立即可用（鉴权通过，只是通道没绿勾）', r.status === 400 && /尚未开通任一收款通道/.test(r.json.error || ''), JSON.stringify(r.json).slice(0, 100));

    // ---------- 零 active 也能轮换 Key ----------
    console.log('零 active 也能轮换 Key');
    r = await req({ method: 'POST', path: `/api/v1/merchants/${mid}/api-key/rotate`, body: {}, cookieJar: jar });
    ok('零 active 时轮换 Key 成功（旧规则已废除）', r.status === 200 && r.json.api_key.startsWith('jk_live_') && r.json.api_key !== apiKey);
    const apiKey2 = r.json.api_key;
    r = await req({ method: 'POST', path: '/api/v1/checkout/sessions',
      body: { merchant_id: mid, order_id: 'k2', amount: 10, currency: 'usd' }, headers: { 'x-api-key': apiKey } });
    ok('旧 Key 失效', r.status === 401);
    r = await req({ method: 'POST', path: '/api/v1/checkout/sessions',
      body: { merchant_id: mid, order_id: 'k3', amount: 10, currency: 'usd' }, headers: { 'x-api-key': apiKey2 } });
    ok('新 Key 可用（鉴权通过）', r.status === 400 && /尚未开通任一收款通道/.test(r.json.error || ''));

    // ---------- 绑定不再发 Key ----------
    console.log('绑定不再发 Key');
    r = await req({ method: 'POST', path: `/api/v1/merchants/${mid}/nowpayments/bind`, body: { api_key: 'np_invalid_key_for_test', ipn_secret: 's3cr3t' }, cookieJar: jar });
    ok('假 Key 绑定失败', r.status === 400);
    r = await req({ method: 'POST', path: `/api/v1/merchants/${mid}/nowpayments/bind`, body: { api_key: 'np_test_key_1', ipn_secret: 's3cr3t' }, cookieJar: jar });
    ok('真 Key 绑定成功变绿', r.status === 200 && r.json.status === 'active');
    ok('绑定成功不再发放 Key（注册时已发）', r.status === 200 && !('api_key' in r.json), JSON.stringify(r.json).slice(0, 120));

    // 建单 + deposit 走 mock，造一笔真实订单
    r = await req({ method: 'POST', path: '/api/v1/checkout/sessions',
      body: { merchant_id: mid, order_id: 'ord_001', amount: 88, currency: 'usd', description: '测试订单' },
      headers: { 'x-api-key': apiKey2 } });
    ok('建单成功', r.status === 200 && r.json.session_id, r.status + ' ' + JSON.stringify(r.json).slice(0, 100));
    ok('rail_options 只含稳定币', r.status === 200 && JSON.stringify(r.json.rail_options) === JSON.stringify(['stablecoin']));
    const sessionId = r.json.session_id;
    r = await req({ method: 'POST', path: `/api/v1/checkout/sessions/${sessionId}/stablecoin/deposit`,
      body: { token: 'USDT', network: 'Tron' } });
    ok('deposit 成功（mock）', r.status === 200 && r.json.payment_id, JSON.stringify(r.json).slice(0, 100));
    const npPaymentId = r.json.payment_id;
    // 模拟 NOWPayments IPN 回调：finished → succeeded
    const ipn = { payment_id: npPaymentId, order_id: 'ord_001', payment_status: 'finished', pay_amount: 88, pay_currency: r.json.pay_currency, price_amount: 88, price_currency: 'usd' };
    r = await req({ method: 'POST', path: `/webhooks/nowpayments/${encodeURIComponent(mid)}`, body: ipn,
      headers: { 'x-nowpayments-sig': signIpn(ipn, 's3cr3t') } });
    ok('IPN 回调成功', r.status === 200 && r.json.received === true, JSON.stringify(r.json).slice(0, 100));
    r = await req({ path: '/api/v1/orders', cookieJar: jar });
    ok('订单状态变为 succeeded', r.status === 200 && (r.json.orders || []).some((o) => o.order_id === 'ord_001' && o.status === 'succeeded'));

    // ---------- 总后台管理员体系 ----------
    console.log('总后台管理员体系');
    const ajar = await adminLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    ok('环境变量自动创建首个超级管理员并可登录', true);
    ok('管理员 Cookie 名为 jirvs_admin（与商户隔离）', /jirvs_admin=/.test(ajar.cookie), ajar.cookie.slice(0, 60));
    r = await req({ method: 'POST', path: '/api/admin/login', body: { email: ADMIN_EMAIL, password: 'wrong' } });
    ok('管理员密码错误被拒绝', r.status === 401);
    r = await req({ path: '/api/admin/me', cookieJar: ajar });
    ok('管理员身份查询', r.status === 200 && r.json.admin.role === 'superadmin');

    // 会话隔离
    r = await req({ path: '/api/admin/overview', cookieJar: jar });
    ok('商户 Cookie 调总后台接口被拒绝', r.status === 401);
    r = await req({ path: '/api/v1/auth/me', cookieJar: ajar });
    ok('管理员 Cookie 调商户接口被拒绝', r.status === 401);

    // 添加只读管理员（v21.7：超管填邮箱直接建，默认密码 123456）
    r = await req({ method: 'POST', path: '/api/admin/admins', body: { email: 'reader@example.com' }, cookieJar: ajar });
    ok('超管添加只读管理员成功', r.status === 200 && r.json.admin.role === 'readonly');
    const readerId = r.json.admin.id;
    const rjar = await adminLogin('reader@example.com', '123456');
    r = await req({ path: '/api/admin/overview', cookieJar: rjar });
    ok('只读管理员可调 GET 接口', r.status === 200 && typeof r.json.merchant_total === 'number');
    r = await req({ method: 'POST', path: '/api/admin/password', body: { old_password: '123456', new_password: 'read1234' }, cookieJar: rjar });
    ok('只读管理员改密码成功', r.status === 200);
    let loginFailed = false;
    try { await adminLogin('reader@example.com', '123456'); } catch { loginFailed = true; }
    ok('旧密码已失效', loginFailed);
    const rjar2 = await adminLogin('reader@example.com', 'read1234');
    r = await req({ path: '/api/admin/overview', cookieJar: rjar2 });
    ok('新密码可登录', r.status === 200);
    r = await req({ method: 'POST', path: `/api/admin/merchants/${encodeURIComponent(mid)}/freeze`, body: { reason: 'x' }, cookieJar: rjar2 });
    ok('只读管理员写操作被拒 403', r.status === 403);
    r = await req({ method: 'POST', path: '/api/admin/admins', body: { email: 'x@example.com' }, cookieJar: rjar2 });
    ok('只读管理员不能添加管理员', r.status === 403);
    r = await req({ path: '/api/admin/admins', cookieJar: ajar });
    ok('管理员列表可见', r.status === 200 && r.json.admins.length === 2);
    r = await req({ method: 'DELETE', path: `/api/admin/admins/${readerId}`, cookieJar: rjar2 });
    ok('只读管理员不能删除管理员', r.status === 403);
    r = await req({ method: 'DELETE', path: `/api/admin/admins/${readerId}`, cookieJar: ajar });
    ok('超管删除管理员成功', r.status === 200);
    r = await req({ path: '/api/admin/admins', cookieJar: ajar });
    ok('删除后只剩超管', r.status === 200 && r.json.admins.length === 1);

    // ---------- 冻结 / 解冻 ----------
    console.log('冻结 / 解冻');
    r = await req({ method: 'POST', path: `/api/admin/merchants/${encodeURIComponent(mid)}/freeze`, body: {}, cookieJar: ajar });
    ok('冻结无原因被拒 400', r.status === 400);
    r = await req({ method: 'POST', path: `/api/admin/merchants/${encodeURIComponent(mid)}/freeze`, body: { reason: '测试冻结' }, cookieJar: ajar });
    ok('冻结成功', r.status === 200 && r.json.status === 'frozen');
    r = await req({ method: 'POST', path: '/api/v1/auth/login', body: { email: 'v22a@example.com', password: 'pass1234' } });
    ok('冻结后商户登录被拒', r.status === 403);
    r = await req({ path: '/api/v1/orders', cookieJar: jar });
    ok('冻结后旧会话失效', r.status === 401);
    r = await req({ method: 'POST', path: '/api/v1/checkout/sessions',
      body: { merchant_id: mid, order_id: 'k4', amount: 10, currency: 'usd' }, headers: { 'x-api-key': apiKey2 } });
    ok('冻结后该商户 Key 全部失效', r.status === 401);
    r = await req({ path: '/api/admin/overview', cookieJar: ajar });
    ok('总览冻结数=1', r.status === 200 && r.json.frozen_count === 1, JSON.stringify(r.json));
    r = await req({ path: `/api/admin/merchants?status=frozen`, cookieJar: ajar });
    ok('商户列表按冻结筛选', r.status === 200 && r.json.merchants.length === 1 && r.json.merchants[0].merchant_id === mid);
    r = await req({ method: 'POST', path: `/api/admin/merchants/${encodeURIComponent(mid)}/unfreeze`, body: {}, cookieJar: ajar });
    ok('解冻成功', r.status === 200 && r.json.status === 'active');
    const jar3 = newJar();
    r = await req({ method: 'POST', path: '/api/v1/auth/login', body: { email: 'v22a@example.com', password: 'pass1234' }, cookieJar: jar3 });
    ok('解冻后商户可重新登录', r.status === 200);
    r = await req({ method: 'POST', path: '/api/v1/checkout/sessions',
      body: { merchant_id: mid, order_id: 'k5', amount: 10, currency: 'usd' }, headers: { 'x-api-key': apiKey2 } });
    ok('解冻后 Key 恢复可用', r.status === 200);
    r = await req({ path: '/api/admin/logs?limit=20', cookieJar: ajar });
    const actions = (r.json.logs || []).map((l) => l.action);
    ok('操作日志记录冻结/解冻（含原因与管理员）',
      r.status === 200 && actions.includes('freeze') && actions.includes('unfreeze')
      && (r.json.logs || []).some((l) => l.action === 'freeze' && l.reason === '测试冻结' && l.admin_email === ADMIN_EMAIL));

    // ---------- 管理员数据 API ----------
    console.log('管理员数据 API');
    r = await req({ path: '/api/admin/overview', cookieJar: ajar });
    ok('总览：商户总数/通道开通数齐全',
      r.status === 200 && r.json.merchant_total === 1 && r.json.stable_active === 1 && r.json.fiat_active === 0
      && r.json.frozen_count === 0, JSON.stringify(r.json));
    ok('总览：今日交易额按法币/稳定币分开',
      r.json.today_volume_fiat !== undefined && r.json.today_volume_stable !== undefined
      && Object.keys(r.json.today_volume_stable).length > 0, JSON.stringify(r.json.today_volume_stable));
    r = await req({ path: `/api/admin/merchants?channel=stablecoin`, cookieJar: ajar });
    ok('商户列表按通道筛选', r.status === 200 && r.json.merchants.length === 1);
    r = await req({ path: `/api/admin/orders?q=${encodeURIComponent('v22a@example.com')}&range=today`, cookieJar: ajar });
    ok('订单按商户邮箱搜索+今天筛选', r.status === 200 && (r.json.orders || []).some((o) => o.order_id === 'ord_001'));
    r = await req({ path: `/api/admin/orders?q=${encodeURIComponent('测试有限公司')}`, cookieJar: ajar });
    ok('订单按商户名称搜索', r.status === 200 && (r.json.orders || []).some((o) => o.order_id === 'ord_001'));
    const todayStr = new Date().toISOString().slice(0, 10);
    r = await req({ path: `/api/admin/orders?range=custom&start=${todayStr}&end=${todayStr}`, cookieJar: ajar });
    ok('订单自定义日期范围筛选', r.status === 200 && (r.json.orders || []).some((o) => o.order_id === 'ord_001'));
    r = await req({ path: `/api/admin/orders?range=7d`, cookieJar: ajar });
    ok('订单近7天筛选', r.status === 200 && (r.json.orders || []).some((o) => o.order_id === 'ord_001'));
    r = await req({ path: '/api/admin/profit?period=day', cookieJar: ajar });
    ok('分润统计（当天）：Antom/NOWPayments 分开',
      r.status === 200 && r.json.antom_fiat && r.json.nowpayments_stable
      && Object.keys(r.json.nowpayments_stable.volume).length > 0, JSON.stringify(r.json.nowpayments_stable));
    r = await req({ path: '/api/admin/profit?period=all', cookieJar: ajar });
    ok('分润统计（累计）', r.status === 200 && r.json.period === 'all');

    // ---------- 订单/资金回归 + 旧接口下线 ----------
    console.log('回归');
    r = await req({ path: '/api/v1/orders', cookieJar: jar3 });
    ok('商户订单列表可用', r.status === 200 && Array.isArray(r.json.orders));
    r = await req({ path: '/api/v1/funds/overview', cookieJar: jar3 });
    ok('资金视图可用', r.status === 200 && typeof r.json.succeeded_count === 'number');
    r = await req({ method: 'POST', path: `/api/v1/merchants/${mid}/payoneer-account`, body: {}, cookieJar: jar3 });
    ok('Payoneer 开户接口已删除', r.status === 404);
  } finally {
    await kill(child);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
