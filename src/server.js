// 统一支付 API 服务：对标 Jirvs 聚合层的对外接口，底层走多机构适配器。
// v18：稳定币通道由 Triple-A（已移除）切换为 NOWPayments（真实接口直调）。
//   - 银行卡 rail=card → Stripe Connect / Checkout（Stripe 负责商户 KYC/KYB 与卡支付）
//   - 稳定币 rail=stablecoin → NOWPayments（真实）：商户在 NOWPayments 官网
//     自行开户并配置自己的收款钱包，在 Jirvs 商户门户绑定自己的 API Key +
//     IPN Secret；Jirvs 服务端代建单、收 IPN、记账，全程不碰资金。
//   - NOWPayments 官方沙盒已下线（2026-09-29 官方支持确认），稳定币通道无
//     沙盒模式；单元测试用 NOWPAYMENTS_MOCK=true 走内存模拟。
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createAdapter: createPayoneerAdapter } = require('./payoneerAdapter');
const { createAdapter: createStripeAdapter } = require('./stripeAdapter');
const {
  createAdapter: createNowPaymentsAdapter,
  supportedTokens,
  resolvePayCurrency,
  encryptSecret,
  decryptSecret,
} = require('./nowpaymentsAdapter');
const { createEventBus } = require('./eventBus');
const { createPlatform } = require('./platform');
const { geoFence } = require('./geoFence'); // 合规：地理围栏，阻止受限地区 IP 发起支付
const eco = require('./ecosystem'); // v21.7 生态合作

const app = express();
// 稳定币业务已下线：在所有历史路由之前统一返回 410，避免旧 Webhook/Deposit 入口被访问。
app.use((req, res, next) => {
  if (/stablecoin|nowpayments|triple.?a/i.test(req.path)) return res.status(410).json({ error: '平台不支持稳定币，仅支持法币收款' });
  next();
});
const PORT = process.env.PORT || 3000;
// v21：发邮件（找回密码）。RESEND_API_KEY 环境变量未设置时只打印日志不真发（本地开发模式）。
// 发件人默认用 Resend 测试地址；验证 jirvs.com 域名后可设 MAIL_FROM="Jirvs <noreply@jirvs.com>"。
const https = require('https');
function sendMail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Jirvs <noreply@jirvs.com>';
  if (!apiKey) {
    console.log(`[mail:dev] 未配置 RESEND_API_KEY，不真发。to=${to} subject=${subject}`);
    console.log(`[mail:dev] html=${String(html).slice(0, 600)}...`);
    return Promise.resolve({ dev: true });
  }
  console.log(`[mail] 发送中 to=${to} from=${from} subject=${subject}`);
  const body = JSON.stringify({ from, to: [to], subject, html });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[mail] 发送成功 status=${res.statusCode} body=${data.slice(0, 200)}`);
          resolve(JSON.parse(data || '{}'));
        }
        else {
          console.error(`[mail] 发送失败 status=${res.statusCode} body=${data.slice(0, 300)}`);
          reject(new Error(`Resend 发信失败 (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (e) => { console.error(`[mail] 网络错误 ${e.message}`); reject(e); });
    req.write(body);
    req.end();
  });
}
const payoneer = createPayoneerAdapter(); // 旧兼容适配器，新的法币流程不再使用
const stripe = createStripeAdapter();
const adapters = { stripe };
// v21.7: Stripe 官方 SDK（v2 Connect 子账户、Checkout Session；Key 走环境变量）
function stripeSdk() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripeSdk._c) stripeSdk._c = require('stripe')(key);
  return stripeSdk._c;
}

// v18: NOWPayments 适配器按商户分别实例化（用各商户自己绑定的 Key）。
// merchant_id -> adapter 实例（绑定/解绑时清缓存）
const npAdapterCache = new Map();
function clearNpAdapterCache(merchant_id) {
  npAdapterCache.delete(merchant_id);
}
// 取出商户 NOWPayments 明文凭证（仅服务端内部用：建单、验签）
function getNpSecrets(merchant_id) {
  const binding = platform.getMerchantNowPaymentsSecrets(merchant_id); // 未绑定直接抛错
  return {
    apiKey: decryptSecret(binding.api_key_enc),
    ipnSecret: decryptSecret(binding.ipn_secret_enc),
  };
}
function getNpAdapter(merchant_id) {
  if (npAdapterCache.has(merchant_id)) return npAdapterCache.get(merchant_id);
  const { apiKey, ipnSecret } = getNpSecrets(merchant_id);
  const a = createNowPaymentsAdapter({ apiKey, ipnSecret });
  npAdapterCache.set(merchant_id, a);
  return a;
}
// 仅验签用（IPN 回调）：不需要 apiKey
function getNpVerifier(merchant_id) {
  const { ipnSecret } = getNpSecrets(merchant_id);
  return createNowPaymentsAdapter({ ipnSecret });
}

const eventBus = createEventBus();
const platform = createPlatform();
// v21.6：首个超级管理员（admins 表为空且设置了 ADMIN_EMAIL/ADMIN_PASSWORD 时自动创建）
platform.ensureSeedAdmin();

// 支付/会话 id -> 通道
const paymentGateway = new Map(); // payment_id -> 'stripe' | 'nowpayments'
const sessionGateway = new Map(); // session_id -> 'stripe' | 'nowpayments'

// IPN 幂等：payment_id:payment_status 已处理过的直接回 200 不重复记账
const processedIpn = new Set();
function ipnKey(payment_id, payment_status) {
  return `${payment_id}:${payment_status}`;
}

// v18 聚合路由：card=银行卡→Stripe；stablecoin=稳定币→NOWPayments。
// 用户只选支付方式，不选机构。
// v22：法币通道统一走 Stripe Connect。
const ROUTE_PRIORITY = { card: ['stripe'] };

// v21.2：通道是否可收款 = 对应通道有没有绿勾（channels_state.status === 'active'）。
// 这是服务端门禁的唯一依据：收银台只显示绿勾通道，建单 API 同规则校验。
// 法币通道（card）→ Antom 真实联调测通才绿；稳定币通道（stablecoin）→ NOWPayments Key 校验通过才绿。
function merchantProviderReady(merchant_id, provider) {
  if (provider === 'stripe') return platform.channelIsActive(merchant_id, 'fiat');
  return false;
}

// 按商户已开通且完成验证的通道，算出收银台该显示哪些支付方式
function availableRails(merchant_id) {
  const rails = [];
  if (ROUTE_PRIORITY.card.some((provider) => merchantProviderReady(merchant_id, provider))) rails.push('card');

  return rails;
}

// 用户选定支付方式后，Jirvs 按优先级选机构（用户不选机构）
function routeProvider(merchant_id, rail) {
  const order = ROUTE_PRIORITY[rail] || [];
  for (const p of order) {
    if (merchantProviderReady(merchant_id, p)) return p;
  }
  throw new Error(`商户 ${merchant_id} 的${rail === 'stablecoin' ? '稳定币' : '法币'}通道尚未开通（请先在商户门户完成该通道注册并验证通过）`);
}

// v14: Jirvs 级聚合收银台会话
const routedSessions = new Map(); // session_id -> routed session

// Webhook 需要原始 body，必须在 express.json() 之前挂载
app.post('/webhooks/payoneer', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await payoneer.parseWebhook(req);
    await eventBus.emit(event);
    res.json({ received: true, event: event.type });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stripe Connect Webhook：必须在 express.json() 前读取原始 body，验签后同步订单。
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = stripe.parseWebhook(req.body.toString(), req.headers['stripe-signature']);
    if (event.event_id && processedIpn.has(`stripe:${event.event_id}`)) return res.json({ received: true, deduped: true });
    if (event.event_id) processedIpn.add(`stripe:${event.event_id}`);
    const order = event.order_id ? platform.getOrder(event.order_id) : platform.findOrderByPayment(event.payment_id);
    if (order) {
      const status = event.status === 'succeeded' ? 'succeeded' : event.status === 'canceled' ? 'canceled' : event.status === 'failed' ? 'failed' : 'pending';
      platform.updateOrder(order.order_id, { status, payment_id: event.payment_id, gateway: 'stripe', rail: 'card' });
      for (const rs of routedSessions.values()) {
        if (rs.order_id === order.order_id || rs.payment_id === event.payment_id) {
          rs.status = status === 'succeeded' ? 'complete' : status === 'canceled' || status === 'failed' ? 'closed' : rs.status;
          rs.rail = 'card'; rs.routed_provider = 'stripe';
        }
      }
      await eventBus.emit({ type: `payment.${status === 'succeeded' ? 'succeeded' : status === 'canceled' ? 'canceled' : status === 'failed' ? 'failed' : 'updated'}`, payment_id: event.payment_id, order_id: order.order_id, merchant_id: order.merchant_id, amount: order.amount, currency: order.currency, provider: 'stripe', rail: 'card' });
    }
    res.json({ received: true, event: event.raw_type });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v18: NOWPayments IPN 回调（按商户区分验签密钥）
// URL 在建单时通过 ipn_callback_url 传入：/webhooks/nowpayments/:merchant_id
// 官方失败会按商户配置重复推送，本接口验签失败回 400、成功回 200，重复推送按幂等键去重。
app.post('/webhooks/nowpayments/:merchant_id', express.raw({ type: 'application/json' }), async (req, res) => {
  const merchant_id = req.params.merchant_id;
  try {
    const verifier = getNpVerifier(merchant_id);
    const raw = req.body.toString();
    const sig = req.headers['x-nowpayments-sig'];
    const event = verifier.parseIpn(raw, sig); // 验签失败直接抛错 → 400
    const key = ipnKey(event.payment_id, event.payment_status);
    if (processedIpn.has(key)) return res.json({ received: true, deduped: true });
    processedIpn.add(key);
    if (processedIpn.size > 5000) {
      // 防止内存无限增长：清掉一半（最老的不保证，v18 够用）
      const arr = [...processedIpn];
      arr.slice(0, 2500).forEach((k) => processedIpn.delete(k));
    }
    applyNpPaymentEvent(merchant_id, event);
    await eventBus.emit({
      type: event.type,
      payment_id: event.payment_id,
      order_id: event.order_id,
      merchant_id,
      amount: event.price_amount,
      currency: event.price_currency,
      provider: 'nowpayments',
      rail: 'stablecoin',
    });
    res.json({ received: true, event: event.type });
  } catch (err) {
    const code = /签名校验失败|未绑定/.test(err.message) ? 400 : 404;
    res.status(code).json({ error: err.message });
  }
});

// 订阅支付回调：支付机构先把原始 JSON 用 SUBSCRIPTION_WEBHOOK_SECRET 做 HMAC-SHA256，
// 放入 x-jirvs-signature；回调成功后才激活订阅和生成一次佣金。
app.post('/webhooks/subscriptions/:provider', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const secret = process.env.SUBSCRIPTION_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: '订阅回调未配置签名密钥' });
    const raw = req.body.toString();
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const actual = String(req.headers['x-jirvs-signature'] || '').replace(/^sha256=/, '');
    if (!actual || actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      return res.status(400).json({ error: '订阅回调签名校验失败' });
    }
    const body = JSON.parse(raw);
    const eventType = String(body.event || body.type || '').toLowerCase();
    if (!['payment.succeeded', 'payment_succeeded', 'succeeded', 'paid'].includes(eventType)) {
      return res.json({ received: true, ignored: true, event: eventType });
    }
    const result = eco.activateSubscription(platform.db, {
      subscriptionId: body.subscription_id || body.subscriptionId,
      paymentId: body.payment_id || body.paymentId,
      amount: Number(body.amount),
      currency: String(body.currency || 'USD').toUpperCase(),
      eventId: body.event_id || body.eventId || `${req.params.provider}:${body.payment_id || body.paymentId}:${eventType}`,
    });
    res.json({ received: true, provider: req.params.provider, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // 沙盒模拟开户页表单
// v21.6: 总后台页面（管理员登录态由前端 JS 检查，未登录显示登录页）
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
// v21.7: 邀请设置密码页已删除——只读管理员由超管直接添加，默认密码 123456，对方登录后自己改。
// v20: 开发者区页面需登录——拦截必须写在 express.static 之前，
// 否则静态中间件会直接把 /pay.html 文件 serve 出去，拦截根本拦不住。
app.get('/pay.html', (req, res) => {
  if (!platform.getSessionUser(getSessionToken(req))) return res.redirect(302, '/portal.html?login=1');
  res.sendFile(path.join(__dirname, '..', 'public', 'pay.html'));
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: false, // v20: 公开演示首页已下掉，/ 走商户门户
}));
// v20: / 直接进商户门户（公开 API 演示页已下掉，调试台搬进登录后的开发者区）
app.get('/', (req, res) => res.redirect(302, '/portal.html'));
// v20: /dev/pay.html 是开发者区入口（同上，需登录）；文件实际仍是 public/pay.html
app.get('/dev/pay.html', (req, res) => {
  if (!platform.getSessionUser(getSessionToken(req))) return res.redirect(302, '/portal.html?login=1');
  res.sendFile(path.join(__dirname, '..', 'public', 'pay.html'));
});

const now = () => new Date().toISOString();
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

// 按 NOWPayments 支付单号找内部订单
function findOrderByNpPaymentId(np_payment_id) {
  const list = platform.listOrders({ limit: 200 }).orders;
  return list.find((o) => o.nowpayments_payment_id === String(np_payment_id)) || null;
}

// 把 NOWPayments 支付状态变更落到订单 + 收银台会话；成功只发一次事件
function applyNpPaymentEvent(merchant_id, event) {
  const order = event.order_id ? (() => { try { return platform.getOrder(event.order_id); } catch { return null; } })()
    : findOrderByNpPaymentId(event.payment_id);
  if (!order) return { ok: false, reason: 'order_not_found' };
  const before = order.status;
  // 注意：不覆盖 order.payment_id（那是 Jirvs 内部支付单号）；NOWPayments 单号只记 nowpayments_payment_id。
  const patch = { nowpayments_payment_id: event.payment_id };
  let emitType = null;
  if (event.status === 'succeeded') {
    patch.status = 'succeeded';
    if (before !== 'succeeded') emitType = 'payment.succeeded';
  } else if (event.status === 'partially_paid') {
    patch.status = 'partially_paid';
    patch.actually_paid = event.actually_paid;
    if (before !== 'partially_paid') emitType = 'payment.partially_paid';
  } else if (['failed', 'expired', 'refunded'].includes(event.status)) {
    patch.status = event.status;
    if (before !== event.status) emitType = 'payment.' + event.status;
  } else {
    patch.status = 'pending'; // waiting / confirming / confirmed / sending：保持待支付
  }
  platform.updateOrder(order.order_id, patch);
  // 同步收银台会话（顾客页轮询用）
  for (const rs of routedSessions.values()) {
    if (rs.nowpayments_payment_id === String(event.payment_id) || rs.order_id === order.order_id) {
      if (event.status === 'succeeded') {
        rs.status = 'complete';
        rs.rail = 'stablecoin';
        rs.routed_provider = 'nowpayments';
      } else if (['failed', 'expired'].includes(event.status)) {
        rs.status = 'closed';
      }
    }
  }
  return { ok: true, emitType, order_id: order.order_id };
}

// 商户必须存在且已完成对应通道的开户/绑定，否则直接拒绝
async function requireOnboardedAccount(merchant_id, provider = 'stripe') {
  let m;
  try {
    m = platform.getMerchant(merchant_id);
  } catch {
    throw new Error(`商户不存在: ${merchant_id}，请先在商户门户完成入驻`);
  }
  if (provider === 'stripe') {
    const info = m.stripe;
    if (!info || !info.account_id || !info.charges_enabled) {
      throw new Error(`商户 ${merchant_id} 尚未完成 Stripe Connect 企业验证，暂不可收款`);
    }
    return info.account_id;
  }
  if (provider === 'nowpayments') {
    const info = m.nowpayments;
    if (!info || !info.bound || !info.charges_enabled) {
      throw new Error(`商户 ${merchant_id} 尚未绑定 NOWPayments，暂不可收稳定币`);
    }
    return 'bound';
  }
  throw new Error(`不支持的通道: ${provider}`);
}

// ---------- v20: 账号体系（邮箱+密码登录，会话 Cookie） ----------
function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)jirvs_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
// v20: 生产 HTTPS 下自动加 Secure（本地 http 不加，否则 Cookie 写不进去）
function isSecureReq(req) {
  return req.protocol === 'https' || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function setSessionCookie(req, res, token, expires_at) {
  const exp = new Date(expires_at).toUTCString();
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `jirvs_session=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; SameSite=Lax${secure}`);
}
function clearSessionCookie(req, res) {
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `jirvs_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure}`);
}
// 商户门户登录态：浏览器会话
function requireAuth(req, res, next) {
  const user = platform.getSessionUser(getSessionToken(req));
  if (!user) return res.status(401).json({ error: '需要登录：请先在商户门户登录' });
  req.user = user;
  next();
}
// 插件/服务端调用：api_key 校验（x-api-key 头或 body.api_key）
function requireApiKey(req, res, next) {
  const body = req.body || {};
  const merchant_id = body.merchant_id || req.query.merchant_id;
  const api_key = req.headers['x-api-key'] || body.api_key || req.query.api_key;
  if (!merchant_id || !api_key || !platform.verifyApiKey(merchant_id, api_key)) {
    return res.status(401).json({ error: 'api_key 无效：请在商户门户复制正确的 API Key（注册成功时仅显示一次）' });
  }
  req.merchant_id = merchant_id;
  next();
}
// 商户归属校验（登录用户只能操作自己的商户）
function requireOwnMerchant(req, res, next) {
  try {
    platform.assertOwnMerchant(req.user.id, req.params.id);
    next();
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}

// ---------- v21.6：总后台管理员鉴权（独立 Cookie jirvs_admin，与商户会话完全隔离） ----------
function getAdminToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)jirvs_admin=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function setAdminCookie(req, res, token, expires_at) {
  const exp = new Date(expires_at).toUTCString();
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `jirvs_admin=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; SameSite=Lax${secure}`);
}
function clearAdminCookie(req, res) {
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `jirvs_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure}`);
}
function requireAdmin(req, res, next) {
  const admin = platform.getAdminSessionAdmin(getAdminToken(req));
  if (!admin) return res.status(401).json({ error: '需要管理员登录' });
  req.admin = admin;
  next();
}
// 只读管理员只能调 GET；写操作需要 superadmin
function requireSuperAdmin(req, res, next) {
  const admin = platform.getAdminSessionAdmin(getAdminToken(req));
  if (!admin) return res.status(401).json({ error: '需要管理员登录' });
  if (admin.role !== 'superadmin') return res.status(403).json({ error: '只读管理员无权执行该操作' });
  req.admin = admin;
  next();
}

// ---------- v21.7：注册邮箱验证码 ----------
const regCodeStore = new Map(); // email -> { code, exp, lastSend }
const REG_CODE_TTL = 10 * 60 * 1000; // 验证码 10 分钟有效
const REG_CODE_GAP = 60 * 1000;      // 同一邮箱 60 秒内只能发一次

// 获取验证码：生成 6 位数字并发送到邮箱（未配置 RESEND_API_KEY 时打印到控制台，dev 模式）
app.post('/api/v1/auth/send-code', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: '请填写正确的邮箱' });
    const prev = regCodeStore.get(email);
    if (prev && Date.now() - prev.lastSend < REG_CODE_GAP) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    regCodeStore.set(email, { code, exp: Date.now() + REG_CODE_TTL, lastSend: Date.now() });
    const html = `<p>你的 Jirvs 商户门户注册验证码是：<b style="font-size:20px;letter-spacing:4px">${code}</b>（10 分钟内有效）。</p><p>如果这不是你本人的操作，请忽略本邮件。</p>`;
    try { await sendMail({ to: email, subject: 'Jirvs 商户门户：注册验证码', html }); }
    catch (e) { console.error('[send-code] 发信失败:', e.message); return res.status(502).json({ error: '验证码邮件发送失败，请稍后重试' }); }
    // 本地开发未配 RESEND_API_KEY 时，sendMail 内部会把验证码打印到控制台（服务端仍可调试）
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 校验验证码（注册「下一步」用；不消费，真正注册时后端再校验一次防绕过）
app.post('/api/v1/auth/verify-code', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const code = String((req.body || {}).code || '').trim();
  const rec = regCodeStore.get(email);
  if (!rec || Date.now() > rec.exp) return res.status(400).json({ error: '验证码已过期，请重新获取' });
  if (rec.code !== code) return res.status(400).json({ error: '验证码错误' });
  res.json({ ok: true });
});

// 账号注册：一个邮箱即可（v20：Jirvs 注册就是一个邮箱+密码）
// v21.7：注册改为两步——先邮箱验证码校验，再填主体信息；主体信息在注册时一并落库
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, password, code, company_name, country, ref_code } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    // 1) 验证码校验（通过后消费，一次性）
    const rec = regCodeStore.get(em);
    if (!rec || Date.now() > rec.exp) return res.status(400).json({ error: '验证码已过期，请重新获取' });
    if (rec.code !== String(code || '').trim()) return res.status(400).json({ error: '验证码错误' });
    // 2) 主体信息校验
    const name = String(company_name || '').trim();
    const ctry = String(country || '').trim().toUpperCase();
    if (!name) return res.status(400).json({ error: '请填写主体名称' });
    if (!['CN', 'HK', 'OTHER'].includes(ctry)) return res.status(400).json({ error: '请选择主体地区' });
    // 3) 建账号
    const user = platform.createUser({ email: em, password });
    regCodeStore.delete(em);
    // 4) 主体信息落库：创建商户草稿并写入公司名/地区（与门户里「完善信息」同一套存储）
    try {
      const created = platform.createMerchantDraft(user.id, user.email);
      platform.saveChannelDraft(created.merchant_id, 'fiat', { name, country: ctry });
    } catch (e) { console.error('[register] 主体信息保存失败:', e.message); }
    const ref = String(ref_code || '').trim().toUpperCase();
    if (ref) {
      const partner = platform.db.prepare("SELECT ref_code FROM partners WHERE ref_code = ? AND sign_status = 'signed'").get(ref);
      if (partner) platform.db.prepare('UPDATE users SET referral_code = ?, referral_captured_at = ? WHERE id = ?').run(ref, new Date().toISOString(), user.id);
    }
    const sess = platform.createSession(user.id);
    setSessionCookie(req, res, sess.token, sess.expires_at);
    res.json({ user, expires_at: sess.expires_at });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 账号登录
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = platform.verifyUser(email, password);
    // v21.6：被冻结的商户禁止登录门户
    if (platform.isUserFrozen(user.id)) {
      return res.status(403).json({ error: '该商户已被冻结，请联系 Jirvs 管理员' });
    }
    const sess = platform.createSession(user.id);
    setSessionCookie(req, res, sess.token, sess.expires_at);
    res.json({ user, expires_at: sess.expires_at });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// 退出登录
app.post('/api/v1/auth/logout', (req, res) => {
  platform.deleteSession(getSessionToken(req));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// v21：修改密码（登录态；验旧密码）
app.post('/api/v1/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { old_password, new_password } = req.body || {};
    res.json(platform.changePassword(req.user.id, old_password, new_password));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v21：忘记密码——发重置邮件（链接 1 小时有效，一次有效）。
// 为防枚举：邮箱不存在也回 ok:true（真发不发由服务端决定）。
app.post('/api/v1/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    const pr = platform.createPasswordReset(email);
    if (pr) {
      const link = `${baseUrl(req)}/portal.html?reset_token=${pr.token}`;
      const html = `<p>你在 Jirvs 商户门户申请了重置密码，点击下面链接重设（1 小时内有效，只能用一次）：</p>
<p><a href="${link}">${link}</a></p>
<p>如果你没有申请，请忽略这封邮件。</p>`;
      try { await sendMail({ to: pr.email, subject: 'Jirvs 商户门户：重置密码', html }); }
      catch (e) { console.error('[forgot-password] 发信失败:', e.message); }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v21：用重置链接重设密码
app.post('/api/v1/auth/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    res.json(platform.resetPasswordWithToken(token, new_password));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 当前登录账号
app.get('/api/v1/auth/me', (req, res) => {
  const user = platform.getSessionUser(getSessionToken(req));
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ user });
});

// 健康检查
app.get('/api/v1/health', (req, res) => {
  res.json({
    ok: true,
    mode: stripe.isConfigured() ? (stripe.isSandbox() ? 'test' : 'live') : 'unconfigured',
    time: now(),
    channels: {
      // 银行卡通道：Stripe Connect + Checkout
      stripe: { configured: stripe.isConfigured(), mode: stripe.isConfigured() ? (stripe.isSandbox() ? 'test' : 'live') : 'unconfigured' },
      // 稳定币通道：NOWPayments 真实接口（官方已无沙盒；NOWPAYMENTS_MOCK=true 时为内存模拟）
      nowpayments: { mode: process.env.NOWPAYMENTS_MOCK === 'true' ? 'mock' : 'live' },
    },
    geo_fence: {
      enabled: process.env.GEO_FENCE_ENABLED === 'true',
      blocked_countries: (process.env.GEO_BLOCKED_COUNTRIES || 'CN').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    },
  });
});

// 创建支付（地理围栏：受限地区 IP 直接 403）
// v22: rail=card 走 Stripe Checkout（银行卡）；rail=stablecoin 走 NOWPayments（稳定币，
// 需同时传 token / network，币种与网络由调用方（收银台）指定）。
// v20: 插件/服务端调用需带 api_key（x-api-key 头或 body.api_key），商户零部署、凭 Key 调用。
app.post('/api/v1/payments', geoFence, requireApiKey, async (req, res) => {
  try {
    const _b = req.body || {};
    if (_b.provider != null && _b.provider !== '') {
      return res.status(400).json({ error: 'provider 参数已废弃：v18 只走 Jirvs 聚合路由，请传 rail（card=银行卡 / stablecoin=稳定币）' });
    }
    const { merchant_id, order_id, amount, currency, description, webhook_url, platform_fee } = _b;
    if (!merchant_id || !order_id || amount == null || !currency) {
      return res.status(400).json({ error: 'merchant_id, order_id, amount, currency 为必填项' });
    }
    if (Number(amount) <= 0) return res.status(400).json({ error: 'amount 必须大于 0' });
    const rail = String((req.body && req.body.rail) || 'card').toLowerCase();
    if (!['card', 'stablecoin'].includes(rail)) {
      return res.status(400).json({ error: 'rail 仅支持 card / stablecoin' });
    }
    let provider;
    try {
      provider = routeProvider(merchant_id, rail);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const base = baseUrl(req);
    let payment;
    if (provider === 'nowpayments') {
      const acct = await requireOnboardedAccount(merchant_id, 'nowpayments');
      const token = _b.token, network = _b.network;
      if (!token || !network) {
        return res.status(400).json({ error: '稳定币直接支付需同时传 token（USDT/USDC）与 network（网络）' });
      }
      let resolved;
      try {
        resolved = resolvePayCurrency(token, network);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const np = getNpAdapter(merchant_id);
      const npPayment = await np.createPayment({
        order_id, amount, currency, description,
        token: resolved.token, network: resolved.network,
        ipn_callback_url: `${base}/webhooks/nowpayments/${merchant_id}`,
      });
      payment = {
        payment_id: npPayment.payment_id,
        order_id, merchant_id,
        amount: Number(amount), currency: String(currency).toLowerCase(),
        status: npPayment.status,
        rail: 'stablecoin',
        token: resolved.token, network: resolved.network,
        pay_amount: npPayment.pay_amount, pay_currency: npPayment.pay_currency,
        deposit_address: npPayment.pay_address,
        nowpayments_payment_id: npPayment.payment_id,
        gateway: 'nowpayments', mode: npPayment.mode,
        description: description || '',
        method: platform.railDisplayName({ rail, token: resolved.token, network: resolved.network }),
        created_at: now(),
      };
      void acct;
    } else {
      const gw = adapters[provider];
      const acct = await requireOnboardedAccount(merchant_id, provider);
      payment = await gw.createPayment({
        merchant_id, order_id, amount, currency, description,
        connected_account_id: provider === 'stripe' ? acct : undefined,
        platform_fee,
        success_url: `${base}/success.html`,
        cancel_url: base + '/pay.html',
      });
      payment.rail = rail;
      payment.method = platform.railDisplayName({ rail });
    }
    paymentGateway.set(payment.payment_id, provider);
    if (payment.session_id) sessionGateway.set(payment.session_id, provider);
    if (webhook_url) eventBus.register(payment.payment_id, webhook_url);
    platform.recordOrder({ ...payment, description });
    await eventBus.emit({
      type: 'payment.created',
      payment_id: payment.payment_id,
      order_id,
      merchant_id,
      amount: Number(amount),
      currency: String(currency).toLowerCase(),
    });
    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 查询支付状态
app.get('/api/v1/payments/:id', async (req, res) => {
  try {
    const provider = paymentGateway.get(req.params.id) || 'stripe';
    if (provider === 'nowpayments') {
      // 直接查单需知道商户；先从内部订单反查
      const list = platform.listOrders({ limit: 200 }).orders;
      const o = list.find((x) => x.payment_id === req.params.id || x.nowpayments_payment_id === req.params.id);
      if (!o) return res.status(404).json({ error: '支付不存在: ' + req.params.id });
      const np = getNpAdapter(o.merchant_id);
      return res.json(await np.getPayment(o.nowpayments_payment_id || req.params.id));
    }
    const gw = adapters[provider];
    if (provider === 'stripe') {
      const order = platform.findOrderByPayment(req.params.id);
      if (!order) return res.status(404).json({ error: '支付不存在: ' + req.params.id });
      const merchant = platform.getMerchant(order.merchant_id);
      return res.json(await gw.getPayment(req.params.id, merchant.stripe && merchant.stripe.account_id));
    }
    res.json(await gw.getPayment(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// 取消支付（NOWPayments 链上支付不支持取消）
// v20: 需 api_key，且 Key 必须属于该支付单的商户
app.post('/api/v1/payments/:id/cancel', async (req, res) => {
  try {
    const api_key = req.headers['x-api-key'] || (req.body || {}).api_key;
    const order = platform.findOrderByPayment(req.params.id);
    if (!order || !api_key || !platform.verifyApiKey(order.merchant_id, api_key)) {
      return res.status(401).json({ error: 'api_key 无效' });
    }
    const provider = paymentGateway.get(req.params.id) || 'stripe';
    if (provider === 'nowpayments') {
      return res.status(400).json({ error: 'NOWPayments 链上支付单不支持取消接口；未付款的订单会自动过期' });
    }
    const gw = adapters[provider];
    const merchant = platform.getMerchant(order.merchant_id);
    const payment = await gw.cancelPayment(req.params.id, provider === 'stripe' ? merchant.stripe && merchant.stripe.account_id : undefined);
    platform.updateOrder(payment.order_id, { status: 'canceled', payment_id: payment.payment_id });
    await eventBus.emit({
      type: 'payment.canceled',
      payment_id: payment.payment_id,
      order_id: payment.order_id,
      merchant_id: payment.merchant_id,
      amount: payment.amount,
      currency: payment.currency,
    });
    res.json(payment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v21.6：删除退款发起接口——一切跟钱有关的操作 Jirvs 都不做。
// 退款请商户自己去 Antom 后台操作；Jirvs 只通过网关事件只读同步"已退款"状态（见 applyGatewayEvent），绝不主动发起资金划转。

// 仅沙盒：模拟用户完成支付（银行卡通道；稳定币为真实链上支付，不可模拟）
app.post('/api/v1/payments/:id/simulate-success', async (req, res) => {
  const provider = paymentGateway.get(req.params.id) || 'stripe';
  if (provider === 'nowpayments') {
    return res.status(400).json({ error: '稳定币为真实链上支付，不支持模拟确认；请真实付款后等待到账' });
  }
  if (provider === 'stripe') return res.status(400).json({ error: 'Stripe 使用托管 Checkout 和 Webhook，不支持本地模拟确认' });
  const gw = adapters[provider];
  if (!gw.isSandbox()) return res.status(400).json({ error: '仅沙盒模式可用' });
  try {
    const payment = gw.simulateSuccess(req.params.id);
    platform.updateOrder(payment.order_id, { status: 'succeeded', payment_id: payment.payment_id });
    await eventBus.emit({
      type: 'payment.succeeded',
      payment_id: payment.payment_id,
      order_id: payment.order_id,
      merchant_id: payment.merchant_id,
      amount: payment.amount,
      currency: payment.currency,
    });
    res.json(payment);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// 创建托管收银台（Checkout Session）：动态支付方式。
// v18: 用户在收银台选支付方式（card=银行卡 / stablecoin=稳定币），
// 走哪家机构由 Jirvs 按优先级自动决定（card→Stripe，stablecoin→NOWPayments），
// 收银台 tab 按商户开通情况渲染（session.rail_options）。
// v20: 需 api_key（插件把 Key 填进去就能用，商户零部署）。
// 地理围栏：受限地区 IP 直接 403
app.post('/api/v1/checkout/sessions', geoFence, requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.provider != null && body.provider !== '') {
      return res.status(400).json({ error: 'provider 参数已废弃：v18 只走 Jirvs 聚合路由，用户只选支付方式不选机构' });
    }
    const { merchant_id, order_id, amount, currency, description, success_url, cancel_url, webhook_url, platform_fee } = body;
    if (!merchant_id || !order_id || amount == null || !currency) {
      return res.status(400).json({ error: 'merchant_id, order_id, amount, currency 为必填项' });
    }
    if (Number(amount) <= 0) return res.status(400).json({ error: 'amount 必须大于 0' });
    const base = `${req.protocol}://${req.get('host')}`;

    const rails = availableRails(merchant_id);
    if (!rails.length) {
      let exists = true;
      try { platform.getMerchant(merchant_id); } catch { exists = false; }
      return res.status(400).json({ error: exists
        ? `商户 ${merchant_id} 尚未开通任一收款通道（通道需要先注册并验证通过拿到绿勾），请先去商户门户完成通道注册`
        : `商户不存在: ${merchant_id}，请先在商户门户完成入驻` });
    }
    const session_id = 'cs_' + crypto.randomBytes(12).toString('hex');
    const session = {
      session_id,
      checkout_url: `/checkout/${session_id}`,
      order_id,
      merchant_id,
      amount: Number(amount),
      currency: String(currency).toLowerCase(),
      description: description || '',
      status: 'open',
      payment_id: 'pi_' + crypto.randomBytes(12).toString('hex'),
      rail_options: rails,   // 收银台显示哪些支付 tab：['card'] / ['stablecoin'] / ['card','stablecoin']
      rail: '',              // 用户实际选定的支付方式（card/stablecoin），收银台回传
      token: '',             // 稳定币：币种（USDT/USDC），deposit 接口写入
      network: '',           // 稳定币：网络，deposit 接口写入
      deposit_address: '',   // 稳定币：收款地址，deposit 接口写入（NOWPayments 真实返回）
      nowpayments_payment_id: '', // 稳定币：NOWPayments 支付单号，deposit 接口写入
      pay_amount: null,      // 稳定币：应付币数，deposit 接口写入
      pay_currency: '',      // 稳定币：NOWPayments 币种代码，deposit 接口写入
      routed: true,          // Jirvs 聚合路由：机构在用户选定支付方式后决定
      gateway: 'jirvs',
      mode: 'live',
      success_url: success_url || `${base}/pay.html`,
      // v20: 没传 cancel_url 时默认用浏览器返回（回到商户自己的网站），
      // 不再指向 /pay.html（那是登录后的开发者调试页，消费者点过去会被踢去登录）。
      cancel_url: cancel_url || 'javascript:history.back()',
      platform_fee: Number(platform_fee) || 0,
      created_at: now(),
    };
    routedSessions.set(session_id, session);
    if (webhook_url) eventBus.register(session_id, webhook_url);
    platform.recordOrder({ ...session, description });
    await eventBus.emit({
      type: 'checkout.session.created',
      payment_id: session_id,
      order_id,
      merchant_id,
      amount: Number(amount),
      currency: String(currency).toLowerCase(),
    });
    return res.json({ ...session, note: 'Jirvs 聚合路由：支付方式由用户在收银台选择，机构按优先级自动路由' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 查询收银台会话状态（成功页轮询用）
app.get('/api/v1/checkout/sessions/:id', async (req, res) => {
  try {
    const rs = routedSessions.get(req.params.id); // 先查 Jirvs 聚合会话
    if (rs) return res.json(rs);
    const gw = adapters[sessionGateway.get(req.params.id) || 'stripe'];
    res.json(await gw.getCheckoutSession(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// 银行卡收银台：创建 Stripe Checkout Session 后跳转到 Stripe 托管页面。
app.post('/api/v1/checkout/sessions/:id/card/checkout', async (req, res) => {
  const rs = routedSessions.get(req.params.id);
  if (!rs) return res.status(404).json({ error: '收银台会话不存在或已过期' });
  if (!rs.rail_options.includes('card')) return res.status(400).json({ error: '该商户未开通银行卡支付' });
  try {
    const provider = routeProvider(rs.merchant_id, 'card');
    const account = await requireOnboardedAccount(rs.merchant_id, provider);
    const payment = await stripe.createPayment({
      connected_account_id: account,
      order_id: rs.order_id,
      merchant_id: rs.merchant_id,
      amount: rs.amount,
      currency: rs.currency,
      description: rs.description || rs.order_id,
      success_url: rs.success_url || `${baseUrl(req)}/success.html`,
      cancel_url: rs.cancel_url || `${baseUrl(req)}/pay.html`,
    });
    rs.payment_id = payment.payment_id;
    rs.session_id = rs.session_id;
    rs.checkout_url = payment.checkout_url;
    rs.rail = 'card';
    rs.routed_provider = 'stripe';
    rs.stripe_account = account;
    rs.gateway = 'stripe';
    rs.mode = payment.mode;
    paymentGateway.set(payment.payment_id, 'stripe');
    sessionGateway.set(payment.session_id, 'stripe');
    platform.updateOrder(rs.order_id, { payment_id: payment.payment_id, gateway: 'stripe', rail: 'card', mode: payment.mode, status: payment.status });
    await eventBus.emit({ type: 'payment.created', payment_id: payment.payment_id, order_id: rs.order_id, merchant_id: rs.merchant_id, amount: rs.amount, currency: rs.currency, provider: 'stripe', rail: 'card' });
    res.json({ ...payment, session_id: rs.session_id, checkout_url: payment.checkout_url });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// 模拟用户在收银台完成支付
// v18: 仅 card（银行卡，Payoneer 沙盒模拟）可用；stablecoin 为真实链上支付，
// 不可模拟——顾客真实付款后由 NOWPayments IPN / 兜底轮询确认。
app.post('/api/v1/checkout/sessions/:id/simulate-success', async (req, res) => {
  const rs = routedSessions.get(req.params.id);
  if (!rs) return res.status(404).json({ error: '收银台会话不存在或已过期' });
  try {
    const rail = String((req.body && req.body.rail) || 'card').toLowerCase();
    if (!['card', 'stablecoin'].includes(rail)) return res.status(400).json({ error: 'rail 仅支持 card / stablecoin' });
    if (!rs.rail_options.includes(rail)) {
      return res.status(400).json({ error: `该商户未开通${rail === 'stablecoin' ? '稳定币' : '银行卡'}支付` });
    }
    if (rail === 'stablecoin') {
      return res.status(400).json({ error: '稳定币为真实链上支付，不支持模拟确认；请真实付款后等待到账' });
    }
    if (!payoneer.isSandbox()) return res.status(400).json({ error: '仅沙盒模式可用' });
    let routedProvider = null;
    for (const p of ROUTE_PRIORITY[rail] || []) {
      if (merchantProviderReady(rs.merchant_id, p)) { routedProvider = p; break; }
    }
    if (!routedProvider) return res.status(400).json({ error: '暂无可用收款通道，请稍后重试' });
    rs.status = 'complete';
    rs.rail = rail;
    rs.routed_provider = routedProvider;
    let acctId = '';
    try { const mm = platform.getMerchant(rs.merchant_id); acctId = ((mm.payoneer) || {}).account_id || ''; } catch { /* 忽略 */ }
    const payment = {
      payment_id: rs.payment_id,
      order_id: rs.order_id,
      merchant_id: rs.merchant_id,
      amount: rs.amount,
      currency: rs.currency,
      status: 'succeeded',
      gateway: routedProvider,
      rail,
      method: platform.railDisplayName({ rail }),
      payoneer_account: acctId,
      mode: 'sandbox',
      created_at: now(),
    };
    platform.updateOrder(rs.order_id, {
      status: 'succeeded', payment_id: payment.payment_id, rail, gateway: routedProvider,
      payoneer_account: acctId,
    });
    await eventBus.emit({
      type: 'payment.succeeded',
      payment_id: payment.payment_id,
      order_id: rs.order_id,
      merchant_id: rs.merchant_id,
      amount: rs.amount,
      currency: rs.currency,
      provider: routedProvider,
      rail,
    });
    return res.json({ session: { ...rs }, payment, provider: routedProvider });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// 托管收银台页：同一个 URL 按会话渲染。Jirvs 聚合会话渲染聚合收银台。
// v18: 消费者正式 URL 为 /checkout/:id（不再出现 sandbox 字样）；
// /sandbox-checkout/:id 仅作内部兼容重定向。
app.get('/sandbox-checkout/:id', (req, res) => {
  res.redirect(302, `/checkout/${req.params.id}`);
});
app.get('/checkout/:id', async (req, res) => {
  const rs = routedSessions.get(req.params.id); // 先查 Jirvs 聚合会话
  if (rs) {
    return res.send(renderCheckout(rs, 'jirvs'));
  }
  // v21.2：非聚合会话直接 404（旧 Payoneer 直连链路已下掉，不再回退）。
  return res.status(404).send('收银台会话不存在或已过期');
});

// ---- 稳定币（NOWPayments）前端接口 ----

// 稳定币选项（公开接口，无需鉴权）：币种 × 网络 × 默认网络
app.get('/api/v1/stablecoins/options', (req, res) => {
  res.json({ tokens: supportedTokens() });
});

// 稳定币 deposit：收银台里用户选定币种与网络后调用。
// v18 真实逻辑：用商户绑定的 NOWPayments Key 建单，返回真实收款地址、
// 应付币数；二维码由前端本地生成。非法组合 400；商户未绑定 400；
// NOWPayments 报错（如金额低于最小金额）原文透出。
app.post('/api/v1/checkout/sessions/:id/stablecoin/deposit', async (req, res) => {
  try {
    const rs = routedSessions.get(req.params.id);
    if (!rs) return res.status(404).json({ error: '收银台会话不存在或已过期' });
    if (!rs.rail_options || !rs.rail_options.includes('stablecoin')) {
      return res.status(400).json({ error: '该商户未开通稳定币支付' });
    }
    const { token, network } = req.body || {};
    let resolved;
    try {
      resolved = resolvePayCurrency(token, network);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    let np;
    try {
      np = getNpAdapter(rs.merchant_id);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const base = baseUrl(req);
    let payment;
    try {
      payment = await np.createPayment({
        order_id: rs.order_id,
        amount: rs.amount,
        currency: rs.currency,
        token: resolved.token,
        network: resolved.network,
        description: rs.description || rs.order_id,
        ipn_callback_url: `${base}/webhooks/nowpayments/${rs.merchant_id}`,
      });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
    rs.token = resolved.token;
    rs.network = resolved.network;
    rs.deposit_address = payment.pay_address;
    rs.nowpayments_payment_id = payment.payment_id;
    rs.pay_amount = payment.pay_amount;
    rs.pay_currency = payment.pay_currency;
    platform.updateOrder(rs.order_id, {
      status: 'pending',
      token: resolved.token,
      network: resolved.network,
      deposit_address: payment.pay_address,
      nowpayments_payment_id: payment.payment_id,
      pay_amount: payment.pay_amount,
      pay_currency: payment.pay_currency,
      gateway: 'nowpayments',
      rail: 'stablecoin',
      mode: payment.mode,
    });
    res.json({
      token: resolved.token,
      network: resolved.network,
      address: payment.pay_address,
      qr_text: payment.pay_address, // 前端用该字符串本地生成二维码
      pay_amount: payment.pay_amount,
      pay_currency: payment.pay_currency,
      payment_id: payment.payment_id,
      amount: rs.amount,
      currency: rs.currency,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 稳定币状态主动查询（IPN 未到/延迟时的兜底；收银台前端也会定时调一次）
app.get('/api/v1/checkout/sessions/:id/stablecoin/status', async (req, res) => {
  try {
    const rs = routedSessions.get(req.params.id);
    if (!rs) return res.status(404).json({ error: '收银台会话不存在或已过期' });
    if (!rs.nowpayments_payment_id) {
      return res.status(400).json({ error: '该会话尚未生成稳定币收款单' });
    }
    const np = getNpAdapter(rs.merchant_id);
    const p = await np.getPayment(rs.nowpayments_payment_id);
    const applied = applyNpPaymentEvent(rs.merchant_id, {
      type: 'payment.updated',
      payment_id: p.payment_id,
      order_id: rs.order_id,
      payment_status: p.payment_status,
      status: p.status,
      pay_amount: p.pay_amount,
      actually_paid: p.actually_paid,
      pay_currency: p.pay_currency,
      price_amount: p.price_amount,
      price_currency: p.price_currency,
    });
    if (applied.emitType) {
      await eventBus.emit({
        type: applied.emitType,
        payment_id: p.payment_id,
        order_id: rs.order_id,
        merchant_id: rs.merchant_id,
        amount: rs.amount,
        currency: rs.currency,
        provider: 'nowpayments',
        rail: 'stablecoin',
      });
    }
    res.json({
      status: p.status,
      payment_status: p.payment_status,
      pay_amount: p.pay_amount,
      actually_paid: p.actually_paid,
      pay_currency: p.pay_currency,
      session_status: rs.status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 兜底轮询：每 60 秒检查未完成的稳定币会话（IPN 丢失/延迟时自动捞回）
setInterval(async () => {
  for (const rs of routedSessions.values()) {
    if (!rs.nowpayments_payment_id) continue;
    if (['complete', 'closed'].includes(rs.status)) continue;
    try {
      const np = getNpAdapter(rs.merchant_id);
      const p = await np.getPayment(rs.nowpayments_payment_id);
      const applied = applyNpPaymentEvent(rs.merchant_id, {
        type: 'payment.updated',
        payment_id: p.payment_id,
        order_id: rs.order_id,
        payment_status: p.payment_status,
        status: p.status,
        pay_amount: p.pay_amount,
        actually_paid: p.actually_paid,
        pay_currency: p.pay_currency,
        price_amount: p.price_amount,
        price_currency: p.price_currency,
      });
      if (applied.emitType) {
        await eventBus.emit({
          type: applied.emitType,
          payment_id: p.payment_id,
          order_id: rs.order_id,
          merchant_id: rs.merchant_id,
          amount: rs.amount,
          currency: rs.currency,
          provider: 'nowpayments',
          rail: 'stablecoin',
        });
      }
    } catch { /* 单个会话失败不影响其他 */ }
  }
}, 60000);

// ---- Jirvs 平台层：商家注册、内部订单、资金视图（只读） ----

// v20 商家注册：需先登录（邮箱+密码）；第一步先选通道（fiat=法币 / stablecoin=稳定币，可多选）。
//  - 法币通道：大陆主体、香港主体均可注册（v8 老"拒绝大陆主体"规则已作废）；
//    注册后在商户门户直连 Antom 账户（Antom 嵌入式开户待国庆后商务落地）；
//    v20 银行卡收款仍走 Payoneer 沙盒（待 Antom 接入后替换）。
//  - 稳定币通道：个人即可，邮箱注册；收款由第三方 NOWPayments 提供——
//    商户去 NOWPayments 官网注册（邮箱+密码，添加钱包，生成 API Key），
//    回商户门户绑定 API Key + IPN Secret；提币在 NOWPayments，Jirvs 只做技术集成。
// v21.6：分通道独立注册（法币 / 稳定币各走各的向导，不再多选）。
// body: { channel: 'fiat' | 'stablecoin', name, country }
// 注册成功立即自动生成一把 Jirvs API Key 并返回（仅返回一次）；不再等通道变绿。
// 法币通道主体地区：中国大陆 / 香港 / 其他；稳定币通道：香港 / 新加坡 / 其他（无大陆）。
app.post('/api/v1/merchants', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.channel === 'stablecoin') return res.status(410).json({ error: '平台不支持稳定币，仅支持法币收款' });
    const channel = 'fiat';
    const name = String(body.name || body.company_name || body.personal_name || '').trim();
    const country = String(body.country || '').trim().toUpperCase();
    if (!name) return res.status(400).json({ error: channel === 'fiat' ? '请填写公司名称' : '请填写姓名' });
    const allowed = channel === 'fiat' ? ['CN', 'HK', 'OTHER'] : ['HK', 'SG', 'OTHER'];
    if (!allowed.includes(country)) return res.status(400).json({ error: '请选择该通道支持的主体地区' });
    let mid, api_key = null, api_pub_key = null;
    try {
      const created = platform.createMerchantDraft(req.user.id, req.user.email);
      mid = created.merchant_id;
      api_key = created.api_key; api_pub_key = created.api_pub_key; // 首次注册成功时返回，仅此一次；断点续传时为空
    } catch (e) {
      // 该账号已有商户：断点续传，直接复用
      if (!/已完成入驻/.test(e.message)) throw e;
      const list = platform.listMerchants(req.user.id);
      if (!list.length) throw e;
      mid = list[0].merchant_id;
    }
    platform.assertOwnMerchant(req.user.id, mid);
    const profile = platform.saveChannelDraft(mid, channel, { name, country });
    const out = {
      merchant_id: mid, channel, status: profile.status, profile,
      channels_state: platform.getChannelState(mid),
      note: channel === 'fiat'
        ? '法币主体资料已保存。请在门户点击 Stripe Connect，完成 Stripe 企业验证后开通收款。'
        : '法币主体资料已保存。请在门户点击 Stripe Connect 完成开户和验证。',
    };
    if (api_key) {
      out.api_key = api_key;
      out.note = '注册成功！你的 Jirvs live Key 与 public Key 均仅显示一次，请立即复制保存。' + out.note;
    }
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v21.2：查询两通道状态（含资料草稿，供断点续传回填）
app.get('/api/v1/merchants/:id/channels', requireAuth, requireOwnMerchant, async (req, res) => {
  try {
    res.json({ merchant_id: req.params.id, channels: platform.getChannelState(req.params.id) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// v21.2：草稿保存走 POST /api/v1/merchants（channel+name+country），断点续传

// 商户列表（登录后只看自己的；不返回 API key）
app.get('/api/v1/merchants', requireAuth, (req, res) => {
  res.json(platform.listMerchants(req.user.id));
});

// 查询商户（登录后只看自己的；不返回 API key）
app.patch('/api/v1/merchants/:id', requireAuth, requireOwnMerchant, async (req, res) => {
  const { country } = req.body || {};
  if (country && ['CN','HK','OTHER'].includes(country)) {
    platform.db.prepare('UPDATE merchants SET country = ? WHERE merchant_id = ?').run(country, req.params.id);
  }
  res.json({ ok: true });
});
app.get('/api/v1/merchants/:id', requireAuth, requireOwnMerchant, async (req, res) => {
  try {
    res.json(platform.getMerchant(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// v20: 重新生成 API Key（登录 + 归属校验；旧 Key 立即失效；新 Key 只在本次响应返回一次）
app.post('/api/v1/merchants/:id/api-key/rotate', requireAuth, requireOwnMerchant, async (req, res) => {
  try {
    res.json(platform.rotateMerchantKey(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v18: 绑定商户自己的 NOWPayments 凭证
// body: { api_key, ipn_secret } —— 绑定时用只读接口校验 Key 有效性，
// 通过后加密存储（明文只在内存停留一次，永不写文件、永不返回前端）。
app.post('/api/v1/merchants/:id/nowpayments/bind', requireAuth, requireOwnMerchant, async (req, res) => {
  try {
    const { api_key, ipn_secret, personal_name } = req.body || {};
    if (!api_key || !ipn_secret) {
      return res.status(400).json({ error: 'api_key 与 ipn_secret 为必填项' });
    }
    platform.getMerchant(req.params.id); // 不存在直接 404
    const adapter = createNowPaymentsAdapter({ apiKey: String(api_key), ipnSecret: String(ipn_secret) });
    try {
      const conn = await adapter.checkConnection();
      if (!conn.ok) throw new Error('连通性校验未通过');
    } catch (e) {
      return res.status(400).json({ error: 'NOWPayments API Key 校验失败：' + e.message + '（请检查 Key 是否正确、是否已在后台生成）' });
    }
    let coins = [];
    try {
      const mc = await adapter.getMerchantCoins();
      coins = mc.coins || [];
    } catch { /* 币种列表拿不到不阻塞绑定 */ }
    const binding = {
      bound: true,
      api_key_enc: encryptSecret(String(api_key)),
      ipn_secret_enc: encryptSecret(String(ipn_secret)),
      charges_enabled: true,
      verified_at: now(),
      coins,
    };
    clearNpAdapterCache(req.params.id);
    const pub = platform.setMerchantNowPayments(req.params.id, binding);
    // v21.6：Jirvs API Key 在注册成功时已发放，这里不再发；通道变绿只管收款能力
    platform.setChannelStatus(req.params.id, 'stablecoin', 'active');
    if (personal_name && String(personal_name).trim()) platform.updateMerchantProfile(req.params.id, { personal_name: String(personal_name).trim() });
    res.json({
      merchant_id: req.params.id, nowpayments: pub, channel: 'stablecoin', status: 'active',
      note: '稳定币通道已开通（已连稳定币通道）',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v18: 解绑 NOWPayments（清缓存 + 标记未绑定；已建的支付单不受影响）
// v21.2：解绑后通道回到"资料已存"（红问号），主体资料保留，可断点续传；已发放的 Jirvs KEY 不变
app.delete('/api/v1/merchants/:id/nowpayments', requireAuth, requireOwnMerchant, async (req, res) => {
  try {
    platform.getMerchant(req.params.id);
    clearNpAdapterCache(req.params.id);
    platform.setMerchantNowPayments(req.params.id, { bound: false, charges_enabled: false });
    platform.setChannelStatus(req.params.id, 'stablecoin', 'draft');
    res.json({ merchant_id: req.params.id, nowpayments: { bound: false }, channel: 'stablecoin', status: 'draft' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v22：法币通道使用 Stripe Connect Express。
// Stripe 负责商户身份验证、银行卡收款能力和结算；Jirvs 只保存 connected account ID 与状态。
async function createStripeOnboarding(req, res) {
  try {
    const merchant = platform.getMerchant(req.params.id);
    const body = req.body || {};
    const base = baseUrl(req);
    const country = String(body.country || merchant.country || 'US').toUpperCase();
    const refreshUrl = `${base}/api/v1/merchants/${req.params.id}/stripe/refresh`;
    const returnUrl = process.env.STRIPE_CONNECT_RETURN_URL || `${base}/portal.html?stripe=connected&merchant_id=${encodeURIComponent(req.params.id)}`;
    let info = merchant.stripe || {};
    let account;
    if (info.account_id) {
      account = await stripe.getConnectedAccount(info.account_id);
      const link = await stripe.createAccountLink(info.account_id, { refresh_url: refreshUrl, return_url: returnUrl });
      info = {
        ...info,
        bound: true,
        account_id: account.id,
        charges_enabled: !!account.charges_enabled,
        payouts_enabled: !!account.payouts_enabled,
        details_submitted: !!account.details_submitted,
        onboarding_url: link.url,
        mode: stripe.isSandbox() ? 'test' : 'live',
      };
    } else {
      info = await stripe.createConnectedAccount({
        country,
        email: merchant.email || req.user.email,
        business_name: merchant.company_name || merchant.company || '',
        refresh_url: refreshUrl,
        return_url: returnUrl,
      });
      info.bound = true;
    }
    platform.setMerchantStripe(req.params.id, info);
    platform.setChannelStatus(req.params.id, 'fiat', info.charges_enabled ? 'active' : 'pending');
    res.json({
      merchant_id: req.params.id,
      channel: 'fiat',
      status: info.charges_enabled ? 'active' : 'pending',
      stripe: { bound: true, account_id: info.account_id, charges_enabled: !!info.charges_enabled, payouts_enabled: !!info.payouts_enabled, details_submitted: !!info.details_submitted, mode: info.mode, updated_at: info.updated_at || '' },
      onboarding_url: info.onboarding_url,
      note: info.charges_enabled ? 'Stripe 法币通道已开通' : '请在 Stripe 页面完成企业验证，完成后返回 Jirvs',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
app.post('/api/v1/merchants/:id/stripe/connect', requireAuth, requireOwnMerchant, createStripeOnboarding);

// Stripe 的 refresh_url：用户中断或链接过期后重新生成一次性授权链接。
app.get('/api/v1/merchants/:id/stripe/refresh', requireAuth, requireOwnMerchant, createStripeOnboarding);

// 返回 Stripe 账户最新能力状态；Stripe 审核完成后刷新即可变为 active。
app.get('/api/v1/merchants/:id/stripe', requireAuth, requireOwnMerchant, async (req, res) => {
  try {
    const merchant = platform.getMerchant(req.params.id);
    const info = merchant.stripe || {};
    if (!info.account_id) return res.json({ merchant_id: req.params.id, stripe: { bound: false, charges_enabled: false, payouts_enabled: false }, status: 'draft' });
    const account = await stripe.getConnectedAccount(info.account_id);
    const next = platform.setMerchantStripe(req.params.id, {
      ...info,
      bound: true,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      details_submitted: !!account.details_submitted,
      requirements_currently_due: account.requirements?.currently_due || [],
    });
    platform.setChannelStatus(req.params.id, 'fiat', account.charges_enabled ? 'active' : 'pending');
    res.json({ merchant_id: req.params.id, stripe: { bound: true, account_id: next.account_id, charges_enabled: !!next.charges_enabled, payouts_enabled: !!next.payouts_enabled, details_submitted: !!next.details_submitted, requirements_currently_due: next.requirements_currently_due || [], mode: next.mode || (stripe.isSandbox() ? 'test' : 'live'), updated_at: next.updated_at || '' }, status: account.charges_enabled ? 'active' : 'pending' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 内部订单列表：登录后只看自己的商户（?status=&limit=；?merchant_id= 需属于当前账号）
app.get('/api/v1/orders', requireAuth, async (req, res) => {
  try {
    if (req.query.merchant_id) platform.assertOwnMerchant(req.user.id, req.query.merchant_id);
    res.json(platform.listOrders({
      user_id: req.user.id,
      merchant_id: req.query.merchant_id,
      status: req.query.status,
      limit: req.query.limit,
    }));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// 内部订单详情（登录后只看自己的）
app.get('/api/v1/orders/:id', requireAuth, async (req, res) => {
  try {
    const o = platform.getOrder(req.params.id);
    platform.assertOwnMerchant(req.user.id, o.merchant_id);
    res.json(o);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// 资金视图（只读）：登录后只看自己的；NOWPayments 余额只读接口已接（绑定后可用）
// Jirvs 不经手资金，此处仅为只读呈现。
app.get('/api/v1/funds/overview', requireAuth, async (req, res) => {
  try {
    const overview = platform.fundsOverview(req.user.id);
    overview.note = 'Jirvs 不经手资金、不发起退款；此处按内部订单只读汇总。如需退款请去 Stripe 后台操作，Jirvs 仅同步显示状态。NOWPayments 资金直达商户自己的钱包。';
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 事件日志（演示页轮询用）
app.get('/api/v1/events', requireAuth, (req, res) => {
  res.json(eventBus.recent(Number(req.query.limit) || 50));
});

// v21.7：商户订阅状态（只看自己的商户）
app.get('/api/v1/subscriptions/status', requireAuth, (req, res) => {
  try {
    const db = platform.db;
    const merchants = platform.listMerchants(req.user.id);
    if (!merchants.length) return res.json({ active: false, subscription: null, merchant_id: null });
    const mid = merchants[0].merchant_id;
    const sub = db.prepare(
      `SELECT * FROM subscriptions WHERE merchant_id = ? AND status IN ('active', 'pending') ORDER BY created_at DESC LIMIT 1`
    ).get(mid);
    if (!sub) return res.json({ active: false, pending: false, subscription: null, merchant_id: mid });
    res.json({ active: sub.status === 'active', pending: sub.status === 'pending', subscription: sub, merchant_id: mid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 订阅报价与真实支付状态机：无邀请码 $299，有效邀请码 $199。
function latestReferral(req) {
  const raw = req.query.ref_code || req.query.referral_code || req.query.ref || '';
  const body = req.body || {};
  const code = String(body.ref_code || body.referral_code || raw).trim().toUpperCase();
  if (!code) return null;
  const partner = platform.db.prepare("SELECT id, ref_code FROM partners WHERE ref_code = ? AND sign_status = 'signed'").get(code);
  return partner || null;
}

app.get('/api/v1/subscriptions/quote', requireAuth, (req, res) => {
  const ms = platform.listMerchants(req.user.id);
  if (!ms.length) return res.status(400).json({ error: '请先注册商户主体' });
  const partner = latestReferral(req);
  res.json({ plan: 'lifetime', currency: 'USD', amount: partner ? 199 : 299, referral_code: partner ? partner.ref_code : null });
});

app.post('/api/v1/subscriptions/checkout', requireAuth, async (req, res) => {
  try {
    const db = platform.db;
    const merchants = platform.listMerchants(req.user.id);
    if (!merchants.length) return res.status(400).json({ error: '请先注册商户主体' });
    const mid = merchants[0].merchant_id;
    const exist = db.prepare(
      `SELECT id, status FROM subscriptions WHERE merchant_id = ? AND status IN ('active', 'pending') LIMIT 1`
    ).get(mid);
    if (exist) return res.status(400).json({ error: '已订阅，无需重复购买' });
    const sdk = stripeSdk();
    if (!sdk) return res.status(503).json({ error: '订阅支付暂未开通（Stripe 未配置）' });
    const now = eco.nowBJ();
    const id = eco.uid('sub');
    // v21.7：终身订阅，无到期
    const partner = latestReferral(req);
    const amount = partner ? 199 : 299;
    if (partner) {
      // 最新一次有效推荐码覆盖此前推荐关系；不在注册时锁定归因。
      db.prepare("UPDATE merchants SET partner_id = ?, referred_at = datetime('now') WHERE merchant_id = ?").run(partner.id, mid);
    } else {
      db.prepare("UPDATE merchants SET partner_id = '', referred_at = '' WHERE merchant_id = ?").run(mid);
    }
    db.prepare(`INSERT INTO subscriptions (id, merchant_id, plan, amount, currency, status, paid_at, expires_at, referral_code, created_at) VALUES (?, ?, 'lifetime', ?, 'USD', 'pending', '', '', ?, ?)` ).run(id, mid, amount, partner ? partner.ref_code : '', now);
    // v21.7: Stripe Checkout（一次付清；卡 / 微信支付 / 支付宝，需在 Stripe 后台启用）
    const session = await sdk.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'wechat_pay', 'alipay'],
      line_items: [{ price_data: { currency: 'usd', unit_amount: Math.round(amount * 100), product_data: { name: 'Jirvs 终身订阅' } }, quantity: 1 }],
      success_url: `${baseUrl(req)}/portal.html?sub=success`,
      cancel_url: `${baseUrl(req)}/portal.html?sub=cancel`,
      client_reference_id: id,
      metadata: { subscription_id: id, merchant_id: mid },
    });
    try { db.prepare('UPDATE subscriptions SET stripe_session_id = ? WHERE id = ?').run(session.id, id); } catch {}
    res.status(202).json({ ok: true, id, plan: 'lifetime', amount, referral_code: partner ? partner.ref_code : null, status: 'pending', checkout_url: session.url, message: '请完成 Stripe 订阅付款；支付成功回调确认后才会开通并计佣。' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ================= v21.6：总后台 /api/admin/* =================
// 管理员登录（独立 Cookie jirvs_admin，与商户会话隔离）
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const admin = platform.verifyAdmin(email, password);
    const sess = platform.createAdminSession(admin.id);
    setAdminCookie(req, res, sess.token, sess.expires_at);
    platform.logAdmin(admin.email, 'login', '', '');
    res.json({ admin, expires_at: sess.expires_at });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});
app.post('/api/admin/logout', (req, res) => {
  platform.deleteAdminSession(getAdminToken(req));
  clearAdminCookie(req, res);
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => {
  const admin = platform.getAdminSessionAdmin(getAdminToken(req));
  if (!admin) return res.status(401).json({ error: '未登录' });
  res.json({ admin });
});
// 新管理员一次性设置密码（公开接口，token 24 小时有效、一次有效）
// v21.7: 一次性设置密码接口已删除——只读管理员由超管直接添加，默认密码 123456。
// 管理员自己改密码（登录态；改完需用新密码重新登录）
app.post('/api/admin/password', requireAdmin, async (req, res) => {
  try {
    const { old_password, new_password } = req.body || {};
    res.json(platform.changeAdminPassword(req.admin.id, old_password, new_password));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 总览统计
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.json(platform.adminOverview());
});
// 商户列表（?status=active|frozen ?channel=fiat|stablecoin）
app.get('/api/admin/merchants', requireAdmin, (req, res) => {
  res.json({ merchants: platform.adminListMerchants({ status: req.query.status, channel: req.query.channel, limit: req.query.limit }) });
});
// 冻结 / 解冻（超管专属；冻结原因必填）
app.post('/api/admin/merchants/:id/freeze', requireSuperAdmin, (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: '冻结原因必填' });
    res.json(platform.freezeMerchant(req.params.id, { reason, admin_email: req.admin.email }));
  } catch (err) {
    const code = /不存在/.test(err.message) ? 404 : 400;
    res.status(code).json({ error: err.message });
  }
});
app.post('/api/admin/merchants/:id/unfreeze', requireSuperAdmin, (req, res) => {
  try {
    res.json(platform.unfreezeMerchant(req.params.id, { admin_email: req.admin.email }));
  } catch (err) {
    const code = /不存在/.test(err.message) ? 404 : 400;
    res.status(code).json({ error: err.message });
  }
});
// 订单列表（?q=商户名称/邮箱 ?range=today|7d|30d|custom ?start=&end= ?status=）
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(platform.adminListOrders({
    q: req.query.q, range: req.query.range, start: req.query.start, end: req.query.end,
    status: req.query.status, limit: req.query.limit,
  }));
});
// 分润统计（?period=day|month|all；Antom 法币 / NOWPayments 稳定币分开）
app.get('/api/admin/profit', requireAdmin, (req, res) => {
  res.json(platform.adminProfit({ period: req.query.period, start: req.query.start, end: req.query.end }));
});
// v21.7 生态合作：伙伴列表 / 详情 / 佣金 / 打款
app.get('/api/admin/partners', requireAdmin, (req, res) => {
  const db = platform.db;
  const partners = db.prepare('SELECT * FROM partners ORDER BY created_at DESC').all();
  res.json({ partners: partners.map(p => ({ ...p, summary: eco.partnerSummary(db, p.id) })) });
});
app.get('/api/admin/partners/:id', requireAdmin, (req, res) => {
  const db = platform.db;
  const s = eco.partnerSummary(db, req.params.id);
  if (!s) return res.status(404).json({ error: '伙伴不存在' });
  const comms = db.prepare('SELECT * FROM commissions WHERE partner_id = ? ORDER BY created_at DESC LIMIT 200').all(req.params.id);
  const payouts = db.prepare('SELECT * FROM payouts WHERE partner_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
  res.json({ ...s, commissions: comms, payouts });
});
app.post('/api/admin/partners', requireAdmin, (req, res) => {
  try {
    const db = platform.db;
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: '名称必填' });
    const id = eco.uid('p');
    const now = eco.nowBJ();
    db.prepare(`INSERT INTO partners
      (id, name, type, phone, legal_name, bank_account, credit_code, sign_status,
       rate_monthly, rate_yearly, contract_no, signed_at, sign_ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, b.name, b.type || 'personal', b.phone || '', b.legal_name || '',
        b.bank_account || '', b.credit_code || '', b.sign_status || 'unsigned',
        b.rate_monthly || 20, b.rate_yearly || 30,
        b.contract_no || '', b.signed_at || '', b.sign_ip || '', now);
    platform.logAdmin(req.admin.email, '添加伙伴', b.name, '');
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// v21.7: 后台切换伙伴合同版本（V1 生态 30% / V2 战略 50%，特邀）
// 注册时不可见 V2；仅管理员可切换。佣金按产生时的合同版本快照，已产生的佣金不受影响。
app.post('/api/admin/partners/:id/contract', requireAdmin, (req, res) => {
  try {
    const db = platform.db;
    const ver = (req.body || {}).contract_ver;
    if (ver !== 'V1' && ver !== 'V2') return res.status(400).json({ error: 'contract_ver 只能是 V1 或 V2' });
    const p = db.prepare('SELECT id, name, contract_ver FROM partners WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: '伙伴不存在' });
    if ((p.contract_ver || 'V1') === ver) return res.json({ ok: true, unchanged: true, contract_ver: ver });
    const rate = ver === 'V2' ? 50 : 30;
    db.prepare('UPDATE partners SET contract_ver = ?, rate = ? WHERE id = ?').run(ver, rate, req.params.id);
    platform.logAdmin(req.admin.email, '切换伙伴合同版本', p.name, `${p.contract_ver || 'V1'} → ${ver}`);
    res.json({ ok: true, contract_ver: ver, rate });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/partners/:id/payout', requireAdmin, (req, res) => {
  try {
    const db = platform.db;
    const { batch_date } = req.body || {};
    if (!batch_date) return res.status(400).json({ error: 'batch_date 必填' });
    const r = eco.runPayoutBatch(db, req.params.id, batch_date);
    if (!r) return res.status(400).json({ error: '无可打款佣金（可能在金库中或已解约）' });
    platform.logAdmin(req.admin.email, '执行打款', req.params.id, `批次 ${batch_date}，$${r.amount}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ================= v21.7：生态合作伙伴自助 /api/partner/* =================
// 伙伴会话 Cookie（jirvs_partner，与商户/管理员隔离）
function getPartnerToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)jirvs_partner=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function setPartnerCookie(req, res, token, expires_at) {
  const exp = new Date(expires_at).toUTCString();
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `jirvs_partner=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; SameSite=Lax${secure}`);
}
function clearPartnerCookie(req, res) {
  const secure = isSecureReq(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `jirvs_partner=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure}`);
}
function requirePartner(req, res, next) {
  const pt = platform.getPartnerSessionPartner(getPartnerToken(req));
  if (!pt) return res.status(401).json({ error: '需要伙伴登录' });
  req.partner = pt;
  next();
}
// 伙伴登录
app.post('/api/partner/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const pt = platform.verifyPartner(email, password);
    const sess = platform.createPartnerSession(pt.id);
    setPartnerCookie(req, res, sess.token, sess.expires_at);
    res.json({ ok: true, partner: { id: pt.id, name: pt.name, email: pt.email } });
  } catch (e) { res.status(401).json({ error: e.message }); }
});
app.post('/api/partner/logout', (req, res) => {
  platform.deletePartnerSession(getPartnerToken(req));
  clearPartnerCookie(req, res);
  res.json({ ok: true });
});
// 伙伴看自己：资料 + 佣金汇总（只显示自己的比例，不泄露对方）
app.get('/api/partner/me', requirePartner, (req, res) => {
  const db = platform.db;
  const p = db.prepare('SELECT id, name, type, email, phone, contract_ver, rate, ref_code, sign_status, contract_no, signed_at, bank_account, credit_code, legal_name FROM partners WHERE id = ?').get(req.partner.id);
  if (!p) return res.status(404).json({ error: '伙伴不存在' });
  const summary = eco.partnerSummary(db, p.id) || {};
  // 推荐商户数
  const mCount = db.prepare('SELECT COUNT(*) AS c FROM merchants WHERE partner_id = ?').get(p.id);
  res.json({
    partner: {
      id: p.id, name: p.name, type: p.type, email: p.email, phone: p.phone,
      contract_ver: p.contract_ver, rate: p.rate, ref_code: p.ref_code,
      sign_status: p.sign_status, contract_no: p.contract_no, signed_at: p.signed_at,
      bank_account: p.bank_account,
    },
    stats: {
      merchants: mCount ? mCount.c : 0,
      pending: summary.pending || 0,
      pendingCount: summary.pendingCount || 0,
      paid: summary.paid || 0,
      paidCount: summary.paidCount || 0,
    },
  });
});
// 伙伴看自己的佣金明细
app.get('/api/partner/commissions', requirePartner, (req, res) => {
  const db = platform.db;
  const rows = db.prepare(
    `SELECT c.*, m.company AS merchant_name FROM commissions c
     LEFT JOIN merchants m ON m.merchant_id = c.merchant_id
     WHERE c.partner_id = ? ORDER BY c.created_at DESC LIMIT 200`
  ).all(req.partner.id);
  res.json({ commissions: rows });
});
// 伙伴看自己的打款记录
app.get('/api/partner/payouts', requirePartner, (req, res) => {
  const db = platform.db;
  const rows = db.prepare('SELECT * FROM payouts WHERE partner_id = ? ORDER BY created_at DESC LIMIT 50').all(req.partner.id);
  res.json({ payouts: rows });
});
// 新伙伴注册（创建账号 + 签署协议一次完成）
app.post('/api/partner/signup', async (req, res) => {
  try {
    const db = platform.db;
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = String(b.name || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (!password || password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (!name) return res.status(400).json({ error: '名称必填' });
    const exists = db.prepare('SELECT id FROM partners WHERE email = ?').get(email);
    if (exists) return res.status(400).json({ error: '该邮箱已注册' });
    const id = eco.uid('p');
    const now = eco.nowBJ();
    const refCode = ('P' + id.replace(/\D/g, '').slice(-6)).toUpperCase() || ('P' + Date.now().toString().slice(-6));
    const hashPassword = platform.hashPassword;
    db.prepare(`INSERT INTO partners
      (id, name, type, email, password_hash, phone, legal_name, bank_account, credit_code,
       sign_status, contract_no, signed_at, sign_ip, contract_ver, rate, ref_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, b.type || 'personal', email, password, b.phone || '', b.legal_name || '',
        b.bank_account || '', b.credit_code || '', 'signed',
        b.contract_no || ('ECO-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 9000) + 1000)),
        now, req.ip || '', 'V1', 30, refCode, now);
    const sess = platform.createPartnerSession(id);
    setPartnerCookie(req, res, sess.token, sess.expires_at);
    res.json({ ok: true, id, ref_code: refCode });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// v21.7 订阅（商户向 Jirvs 付费）
app.post('/api/admin/subscriptions', requireAdmin, (req, res) => {
  try {
    const db = platform.db;
    const b = req.body || {};
    if (!b.merchant_id || !b.plan || !b.amount) return res.status(400).json({ error: 'merchant_id/plan/amount 必填' });
    const now = eco.nowBJ();
    const id = eco.uid('sub');
    // 到期：月付+30天，年付+365天
    const exp = new Date();
    exp.setDate(exp.getDate() + (b.plan === 'yearly' ? 365 : 30));
    const expires = exp.toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`INSERT INTO subscriptions (id, merchant_id, plan, amount, currency, status, paid_at, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(id, b.merchant_id, b.plan, b.amount, b.currency || 'USD', now, expires, now);
    // 触发佣金
    const comm = eco.onSubscriptionPaid(db, { id, merchant_id: b.merchant_id, plan: b.plan, amount: b.amount, paid_at: now });
    platform.logAdmin(req.admin.email, '录入订阅', b.merchant_id, `${b.plan} $${b.amount}`);
    res.json({ ok: true, id, commission: comm });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/admin/subscriptions', requireAdmin, (req, res) => {
  const db = platform.db;
  const subs = db.prepare('SELECT * FROM subscriptions ORDER BY paid_at DESC LIMIT 200').all();
  res.json({ subscriptions: subs });
});
app.get('/api/admin/notifications', requireAdmin, (req, res) => {
  res.json(platform.adminNotifications());
});
// 操作日志
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  res.json({ logs: platform.listAdminLogs({ limit: req.query.limit }) });
});
// 管理员列表 / 添加 / 删除（超管专属；添加只收 email，直接建只读账号，默认密码 123456）
app.get('/api/admin/admins', requireAdmin, (req, res) => {
  res.json({ admins: platform.listAdmins() });
});
app.post('/api/admin/admins', requireSuperAdmin, (req, res) => {
  try {
    const { email } = req.body || {};
    const a = platform.createAdminDirect({ email, by_email: req.admin.email });
    res.json({ ok: true, admin: { id: a.id, email: a.email, role: a.role }, note: '默认密码 123456，请通知对方登录后修改密码' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/admin/admins/:id', requireSuperAdmin, (req, res) => {
  try {
    res.json(platform.deleteAdmin({ id: req.params.id, by_email: req.admin.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// v18: Jirvs 托管收银台（顾客看到的页面）。
// - 浅色主题（v18 改版：不再用深色）。
// - tab 按会话 rail_options 显示（card=银行卡，stablecoin=稳定币）；用户点 tab 即选 rail，不选机构。
// - 银行卡：只显示 Visa / Mastercard 品牌图标，卡号输入自动识别品牌；不出现任何机构名。
// - 稳定币：版式参考 NOWPayments 支付页——步骤条（选择币种→扫码转账→等待到账）、
//   大额展示、二维码、地址复制、网络警告、到账状态轮询。选定币种与网络后调 deposit
//   接口拿 NOWPayments 真实收款地址（前端本地生成二维码，无外部请求）。
//   约3秒自动确认已取消（那是沙盒模拟的做法）；真实流程是轮询等到账。
// - 页面不出现沙盒/测试/演示字样与任何技术信息（会话 ID、支付 ID 等）。
function renderCheckout(s, provider = 'payoneer') {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let merchantName = s.merchant_id;
  try { const mm = platform.getMerchant(s.merchant_id); if (mm && mm.company_name) merchantName = mm.company_name; } catch {}
  let orderDesc = '';
  try { const oo = platform.getOrder(s.order_id); if (oo && oo.description) orderDesc = oo.description; } catch {}
  const routed = provider === 'jirvs' || !!s.routed;
  const rails = routed ? (s.rail_options || ['card'])
    : (s.rail === 'stablecoin' ? ['stablecoin'] : ['card']);
  const showCard = rails.includes('card');
  const showStable = rails.includes('stablecoin');
  const singleRail = rails.length === 1;
  const initStable = (singleRail && showStable) || (!routed && s.rail === 'stablecoin' && showStable);
  // v20: 页脚只写当前 tab 对应的机构（聚合页初始 tab 是哪个就写哪个；切换时 JS 跟着换）
  const secureNote = routed
    ? (initStable ? '安全支付由 NOWPayments 提供 · 技术支持 Jirvs' : '安全支付由 Stripe 提供 · 技术支持 Jirvs')
    : provider === 'nowpayments' ? '安全支付由 NOWPayments 提供 · 技术支持 Jirvs'
    : '安全支付由 Stripe 提供 · 技术支持 Jirvs';
  // v20: success_url 不传就留空（成功页不自动跳，"返回商家"用浏览器返回），
  // 不再默认指向 /pay.html（登录后的开发者调试页）。
  const returnUrl = String(s.success_url || '').replace('{CHECKOUT_SESSION_ID}', s.session_id);
  const cancelUrl = s.cancel_url || 'javascript:history.back()';
  // 品牌图标：仅 Visa 与 Mastercard（SVG 内联，无外部请求）
  const visaSvg = '<svg viewBox="0 0 48 30" width="44" height="28" aria-label="Visa"><rect x="1" y="1" width="46" height="28" rx="4" fill="#1A1F71"/><text x="24" y="21" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-style="italic" font-weight="bold" font-size="13" fill="#fff">VISA</text></svg>';
  const mcSvg = '<svg viewBox="0 0 48 30" width="44" height="28" aria-label="Mastercard"><rect x="1" y="1" width="46" height="28" rx="4" fill="#1f2937"/><circle cx="20" cy="15" r="9" fill="#EB001B"/><circle cx="28" cy="15" r="9" fill="#F79E1B" fill-opacity="0.9"/></svg>';
  const cardPane = showCard ? `
    <div id="paneCard"${initStable ? ' style="display:none"' : ''}>
      <div class="brands"><span class="brand" id="bVisa" title="Visa">${visaSvg}</span><span class="brand" id="bMc" title="Mastercard">${mcSvg}</span></div>
      <label>卡号</label><input id="cc" inputmode="numeric" autocomplete="cc-number" value="4242 4242 4242 4242" />
      <div class="row"><div><label>有效期</label><input value="12 / 28" autocomplete="cc-exp" /></div><div><label>CVC</label><input value="123" autocomplete="cc-csc" /></div></div>
      <label>持卡人</label><input value="ZHANG SAN" autocomplete="cc-name" />
      <div class="via" style="text-align:left;margin-top:10px">支持 Visa、Mastercard 银行卡</div>
    </div>` : '';
  // 稳定币 pane（NOWPayments 式）：
  // 步骤条 → 选币种/网络 → deposit 拿真实地址 → 大额展示 + 二维码 + 复制地址 + 网络警告 → 轮询等到账
  const stablePane = showStable ? `
    <div id="paneStable"${initStable ? '' : ' style="display:none"'}>
      <div class="steps" id="steps">
        <div class="step on" data-s="1"><i>1</i>选择币种</div>
        <div class="step" data-s="2"><i>2</i>扫码转账</div>
        <div class="step" data-s="3"><i>3</i>等待到账</div>
      </div>
      <div id="pickBox">
        <div class="pickrow">
          <div class="pickcol"><label>币种</label>
            <div class="tokens">
              <button type="button" class="token on" data-token="USDT">USDT</button>
              <button type="button" class="token" data-token="USDC">USDC</button>
            </div>
          </div>
          <div class="pickcol"><label>网络</label>
            <select id="netSel"></select>
          </div>
        </div>
        <div class="via pickhint" style="text-align:left;margin-top:6px">切换币种或网络会自动重新生成收款地址</div>
      </div>
      <div class="wallet" style="margin-top:14px">
        <div id="depLoading"><div class="spin"></div><div>正在生成收款地址…</div></div>
        <div id="depBody" style="display:none">
          <div class="paybig">请支付 <b id="payAmt"></b></div>
          <div class="qr" id="qrBox"></div>
          <div class="scan">用钱包 App 扫码支付</div>
          <div class="addrwrap"><div class="addr" id="depAddr"></div><button type="button" class="ghost copy" id="copyAddr">复制</button></div>
          <div class="warn" id="netWarn"></div>
          <div class="statusline" id="statusLine"><div class="spin sm"></div><span id="statusText">等待到账…</span><span class="elapsed" id="elapsed"></span></div>
          <div class="errline" id="depErr"></div>
        </div>
      </div>
    </div>` : '';
  const tabsHtml = (!singleRail && (showCard || showStable)) ? `
    <div class="tabs">
      ${showCard ? `<div class="${initStable ? 'tab' : 'tab active'}" id="tabCard">银行卡</div>` : ''}
      ${showStable ? `<div class="${initStable ? 'tab active' : 'tab'}" id="tabStable">稳定币</div>` : ''}
    </div>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>安全支付</title>
<script src="/qrcode.js"></script>
<style>
  /* v20: Jirvs 品牌色（官网同步：主色青绿 #3d8b85，点缀金 #c48a3a，文字深藏青 #0e1420） */
  :root { --bg:#f8f9fb; --card:#ffffff; --border:#e2e8f0; --text:#0e1420; --muted:#718096; --accent:#3d8b85; --accent-soft:#eef6f5; --gold:#c48a3a; --ok:#16a34a; --warn:#b45309; --warnbg:#fef3c7; --err:#dc2626; }
  * { box-sizing:border-box; }
  /* v20: 一屏装下——紧凑排布，内容不超出视口 */
  html, body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:12px; }
  .wrap { width:100%; max-width:440px; max-height:100dvh; overflow-y:auto; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:18px 20px 14px; box-shadow:0 8px 30px rgba(14,20,32,.06); }
  .merchant { font-size:12px; color:var(--muted); margin-bottom:2px; }
  .amount { font-size:30px; font-weight:700; margin:2px 0 0; letter-spacing:-.5px; }
  .order { font-size:12px; color:var(--muted); margin-bottom:12px; }
  .tabs { display:flex; gap:8px; margin-bottom:12px; }
  .tab { flex:1; text-align:center; padding:9px; border:1px solid var(--border); border-radius:10px; cursor:pointer; font-size:14px; color:var(--muted); background:#f8fafc; }
  .tab.active { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); font-weight:600; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 5px; }
  input, select { width:100%; background:#f8fafc; border:1px solid var(--border); color:var(--text); border-radius:10px; padding:9px 12px; font-size:14px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .paybtn { width:100%; margin-top:16px; background:var(--accent); color:#fff; border:0; border-radius:10px; padding:12px; font-size:16px; font-weight:600; cursor:pointer; }
  .paybtn:disabled { opacity:.5; cursor:not-allowed; }
  /* v20: "取消并返回"做成真正的按钮样（之前像普通文字，看不出能点） */
  .cancel { display:block; text-align:center; margin-top:10px; font-size:14px; color:var(--accent); text-decoration:none; border:1px solid var(--accent); border-radius:10px; padding:10px; background:#fff; font-weight:600; }
  .cancel:active { background:var(--accent-soft); }
  .wallet { border:1px dashed var(--border); border-radius:12px; padding:10px; text-align:center; font-size:13px; color:var(--muted); background:#fbfdff; }
  .wallet .addr { font-family:ui-monospace,Menlo,monospace; color:var(--text); margin-top:8px; word-break:break-all; }
  .addrwrap { display:flex; align-items:flex-start; gap:8px; margin-top:8px; background:#fff; border:1px solid var(--border); border-radius:10px; padding:8px 10px; }
  .addrwrap .addr { flex:1; margin-top:0; text-align:left; font-size:11.5px; }
  .copy { font-size:12px; padding:6px 14px; flex:none; background:var(--accent); border:0; color:#fff; border-radius:8px; cursor:pointer; }
  .warn { margin-top:8px; font-size:12px; color:var(--warn); background:var(--warnbg); border-radius:8px; padding:7px 10px; line-height:1.6; }
  .paybig { font-size:14px; color:var(--muted); margin-bottom:4px; }
  .paybig b { font-size:24px; color:var(--text); letter-spacing:-.5px; }
  .scan { margin-top:2px; }
  .statusline { margin-top:8px; display:flex; align-items:center; justify-content:center; gap:8px; font-size:13px; }
  .elapsed { color:var(--muted); font-size:12px; }
  .errline { color:var(--err); font-size:13px; margin-top:8px; line-height:1.6; min-height:18px; }
  .qr { margin:4px auto 8px; width:min(38vw,132px); height:min(38vw,132px); background:#fff; border:1px solid var(--border); border-radius:12px; padding:6px; }
  .qr svg { width:100%; height:100%; display:block; }
  .via { text-align:center; font-size:11px; color:var(--muted); margin-top:8px; line-height:1.6; }
  .err { color:var(--err); font-size:13px; margin-top:8px; min-height:18px; }
  .spin { width:22px; height:22px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; margin:0 auto 8px; animation:rot 1s linear infinite; }
  .spin.sm { width:14px; height:14px; margin:0; }
  @keyframes rot { to { transform:rotate(360deg); } }
  .brands { display:flex; gap:10px; margin:2px 0 4px; }
  .brand { display:inline-block; border:1px solid var(--border); border-radius:6px; padding:2px; opacity:.35; transition:opacity .15s; background:#fff; }
  .brand.on { opacity:1; border-color:var(--accent); }
  .tokens { display:flex; gap:8px; }
  .token { flex:1; background:#f8fafc; border:1px solid var(--border); color:var(--muted); border-radius:10px; padding:9px; font-size:14px; cursor:pointer; }
  .token.on { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); font-weight:600; }
  .steps { display:flex; margin:2px 0 2px; }
  .pickrow { display:flex; gap:16px; }
  .pickcol { flex:1; min-width:0; }
  #pickBox .pickcol label { margin-top:8px; }
  .step { flex:1; text-align:center; font-size:12px; color:var(--muted); position:relative; padding-top:24px; }
  .step i { position:absolute; top:0; left:50%; transform:translateX(-50%); width:20px; height:20px; border-radius:50%; background:#e2e8f0; color:var(--muted); font-style:normal; font-size:12px; line-height:20px; }
  .step.on { color:var(--accent); font-weight:600; }
  .step.on i { background:var(--accent); color:#fff; }
  .step.done { color:var(--ok); }
  .step.done i { background:var(--ok); color:#fff; }
  button { cursor:pointer; }
  /* v20: 桌面端稳定币 tab 内容多，针对性收紧，保证 800px 高一屏装下、无内部滚动 */
  @media (min-width:481px) {
    .tabs { margin-bottom:10px; }
    .step { padding-top:22px; }
    #pickBox .pickcol label { margin-top:6px; margin-bottom:4px; }
    .pickhint { margin-top:4px !important; font-size:11px; }
    .wallet { margin-top:10px !important; }
    .paybig { margin-bottom:2px; }
    .qr { margin:2px auto 6px; }
    .addrwrap { margin-top:4px; }
    .warn { margin-top:6px; }
    .statusline { margin-top:6px; }
    .via { margin-top:6px; }
    .cancel { margin-top:8px; }
  }
  /* v20: 手机适配——小屏进一步收紧字号与间距，保证一屏装下 */
  @media (max-width:480px) {
    body { padding:8px; align-items:flex-start; }
    .wrap { max-height:calc(100dvh - 16px); }
    .card { padding:12px 14px 8px; border-radius:14px; }
    .amount { font-size:24px; }
    .order { margin-bottom:8px; }
    .paybig { margin-bottom:4px; }
    .paybig b { font-size:22px; }
    .qr { width:min(38vw,120px); height:min(38vw,120px); margin:2px auto 6px; padding:6px; }
    .pickrow { flex-direction:column; gap:2px; }
    .steps { margin:0 0 2px; }
    .wallet { padding:8px; }
    .addrwrap { margin-top:6px; padding:6px 10px; }
    .warn { font-size:11.5px; margin-top:6px; padding:5px 10px; }
    .statusline { margin-top:6px; font-size:12px; }
    .via { margin-top:6px; }
    .paybtn { padding:11px; font-size:15px; margin-top:10px; }
    .cancel { padding:8px; font-size:13px; margin-top:8px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="merchant">向 ${esc(merchantName)} 付款</div>
    <div class="amount">${esc(s.currency.toUpperCase())} ${esc(s.amount)}</div>
    <div class="order">${esc(orderDesc || s.order_id)}</div>
    ${tabsHtml}
    ${cardPane}
    ${stablePane}
    <div class="err" id="err"></div>
    <button class="paybtn" id="payBtn"${initStable ? ' style="display:none"' : ''}>确认支付 ${esc(s.currency.toUpperCase())} ${esc(s.amount)}</button>
    <a class="cancel" href="${esc(cancelUrl)}">取消并返回</a>
    <div class="via" id="secureNote">${secureNote}</div>
  </div>
</div>
<script>
var sid = ${JSON.stringify(s.session_id)};
var routed = ${routed ? 'true' : 'false'};
var SHOW_STABLE = ${showStable ? 'true' : 'false'};
var INIT_STABLE = ${initStable ? 'true' : 'false'};
var returnUrl = ${JSON.stringify(returnUrl)};
var tabCard = document.getElementById('tabCard'), tabStable = document.getElementById('tabStable');
var paneCard = document.getElementById('paneCard'), paneStable = document.getElementById('paneStable');
var payBtn = document.getElementById('payBtn');
var pollTimer = null, forceTimer = null, elapsedTimer = null, elapsedSec = 0;
function setErr(msg) { document.getElementById('err').textContent = msg || ''; }
function clearTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (forceTimer) { clearInterval(forceTimer); forceTimer = null; }
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}
function setStep(n) {
  var steps = document.querySelectorAll('#steps .step');
  for (var i = 0; i < steps.length; i++) {
    var k = parseInt(steps[i].dataset.s, 10);
    steps[i].classList.toggle('on', k === n);
    steps[i].classList.toggle('done', k < n);
  }
}

// ---- 银行卡：卡号自动识别品牌（仅 Visa / Mastercard）----
function brandOf(num) {
  var d = String(num || '').replace(/\\D/g, '');
  if (!d) return '';
  if (d.charAt(0) === '4') return 'visa';
  if (/^5[1-5]/.test(d)) return 'mc';
  if (d.length >= 4) {
    var p4 = parseInt(d.slice(0, 4), 10);
    if (p4 >= 2221 && p4 <= 2720) return 'mc';
  }
  return '';
}
function paintBrand(b) {
  var v = document.getElementById('bVisa'), m = document.getElementById('bMc');
  if (v) v.classList.toggle('on', b === 'visa');
  if (m) m.classList.toggle('on', b === 'mc');
}
var ccInput = document.getElementById('cc');
if (ccInput) {
  ccInput.addEventListener('input', function () { paintBrand(brandOf(this.value)); });
  paintBrand(brandOf(ccInput.value));
}

// ---- 稳定币（NOWPayments 真实流程）：选币种→选网络→deposit 拿真实地址→轮询等到账 ----
var FALLBACK_TOKENS = [
  { token: 'USDT', networks: ['Tron', 'Ethereum', 'Polygon', 'Arbitrum', 'Solana'], default_network: 'Tron' },
  { token: 'USDC', networks: ['Solana', 'Ethereum', 'Polygon', 'Arbitrum'], default_network: 'Solana' }
];
var tokenSpecs = FALLBACK_TOKENS;
var curToken = 'USDT';
function specOf(t) {
  for (var i = 0; i < tokenSpecs.length; i++) { if (tokenSpecs[i].token === t) return tokenSpecs[i]; }
  return tokenSpecs[0];
}
function renderNetworks() {
  var spec = specOf(curToken);
  var sel = document.getElementById('netSel');
  var html = '';
  for (var i = 0; i < spec.networks.length; i++) {
    var n = spec.networks[i];
    html += '<option value="' + n + '"' + (n === spec.default_network ? ' selected' : '') + '>' + n + '</option>';
  }
  sel.innerHTML = html;
}
function showDepLoading(loading) {
  document.getElementById('depLoading').style.display = loading ? '' : 'none';
  document.getElementById('depBody').style.display = loading ? 'none' : '';
}
function setStep2() { setStep(2); /* 选择器保持可见：用户可随时切换币种/网络（防抖后重新建单） */ }
var depSeq = 0;      // 建单序号：只渲染最后一次请求的结果，旧请求回来直接丢弃
var depTimer = null; // 切换币种/网络防抖：停手 800ms 后才真正建单，避免连续点产生一堆支付单
function scheduleDeposit() {
  if (depTimer) clearTimeout(depTimer);
  depTimer = setTimeout(function () { depTimer = null; requestDeposit(); }, 800);
}
async function requestDeposit() {
  var mySeq = ++depSeq;
  clearTimers();
  setErr('');
  setStep(1);
  document.getElementById('pickBox').style.display = '';
  document.getElementById('depErr').textContent = '';
  var network = document.getElementById('netSel').value;
  showDepLoading(true);
  try {
    var r = await fetch('/api/v1/checkout/sessions/' + sid + '/stablecoin/deposit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: curToken, network: network })
    });
    var d = await r.json();
    if (mySeq !== depSeq) return; // 已有更新的建单请求，丢弃这次的旧结果
    if (!r.ok) throw new Error(d.error || '获取收款地址失败');
    renderDeposit(d);
    setStep2();
    startPolling();
  } catch (err) {
    if (mySeq !== depSeq) return;
    showDepLoading(false);
    setErr(err.message);
  }
}
function renderDeposit(d) {
  showDepLoading(false);
  document.getElementById('payAmt').textContent = d.pay_amount + ' ' + d.token;
  try {
    var q = qrcode(0, 'M');
    q.addData(d.qr_text || d.address);
    q.make();
    document.getElementById('qrBox').innerHTML = q.createSvgTag({ scalable: true });
  } catch (e) {
    document.getElementById('qrBox').innerHTML = '<div style="color:var(--muted);font-size:12px">二维码生成失败，请复制下方地址手动转账</div>';
  }
  document.getElementById('depAddr').textContent = d.address;
  document.getElementById('netWarn').textContent = '请只用 ' + d.network + ' 网络转入 ' + d.token + '，切勿用其他网络或转其他币种，否则资金可能无法找回';
  document.getElementById('statusText').textContent = '等待到账…';
  elapsedSec = 0;
  updateElapsed();
}
function updateElapsed() {
  var m = Math.floor(elapsedSec / 60), ss = elapsedSec % 60;
  document.getElementById('elapsed').textContent = '已等待 ' + m + ' 分 ' + (ss < 10 ? '0' : '') + ss + ' 秒';
}
function goSuccess(method) {
  var qs = '/success.html?session_id=' + sid + '&rail=stablecoin&method=' + encodeURIComponent(method || '稳定币');
  location.href = qs + '&return_url=' + encodeURIComponent(returnUrl);
}
async function pollOnce(force) {
  try {
    var url = force
      ? '/api/v1/checkout/sessions/' + sid + '/stablecoin/status'
      : '/api/v1/checkout/sessions/' + sid;
    var r = await fetch(url);
    var d = await r.json();
    if (!r.ok) return;
    var st = force ? d.status : null;
    var sessionStatus = force ? d.session_status : d.status;
    if (sessionStatus === 'complete') {
      clearTimers();
      setStep(3);
      document.querySelectorAll('#steps .step')[2].classList.add('done');
      document.getElementById('statusText').textContent = '已到账，正在跳转…';
      setTimeout(function () { goSuccess(); }, 800);
      return;
    }
    if (sessionStatus === 'closed') {
      clearTimers();
      document.getElementById('depErr').textContent = '该笔支付已过期或失败，请重新下单';
      document.getElementById('statusText').textContent = '支付未完成';
      return;
    }
    if (force && st === 'partially_paid') {
      var paid = d.actually_paid, need = d.pay_amount;
      document.getElementById('depErr').textContent = '已收到部分付款（' + paid + ' / ' + need + '），请勿重复支付，请联系商户处理补付';
      document.getElementById('statusText').textContent = '部分到账，等待处理…';
    }
  } catch (e) { /* 轮询失败不打断，下一轮继续 */ }
}
function startPolling() {
  clearTimers();
  elapsedTimer = setInterval(function () { elapsedSec++; updateElapsed(); }, 1000);
  pollTimer = setInterval(function () { pollOnce(false); }, 5000);
  forceTimer = setInterval(function () { pollOnce(true); }, 20000); // 每 20 秒强制向 NOWPayments 查一次（IPN 到不了本地时靠它）
  pollOnce(false);
}
async function initStablecoin() {
  try {
    var r = await fetch('/api/v1/stablecoins/options');
    var d = await r.json();
    if (d && d.tokens && d.tokens.length) tokenSpecs = d.tokens;
  } catch (e) { /* 兜底：用内置币种×网络清单 */ }
  renderNetworks();
  var tokens = document.querySelectorAll('.token');
  for (var i = 0; i < tokens.length; i++) {
    tokens[i].onclick = (function (btn) {
      return function () {
        if (btn.dataset.token === curToken) return;
        curToken = btn.dataset.token;
        for (var j = 0; j < tokens.length; j++) tokens[j].classList.toggle('on', tokens[j] === btn);
        renderNetworks();
        scheduleDeposit();
      };
    })(tokens[i]);
  }
  document.getElementById('netSel').onchange = scheduleDeposit;
  var cp = document.getElementById('copyAddr');
  if (cp) cp.onclick = function () {
    var t = document.getElementById('depAddr').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { cp.textContent = '已复制'; });
  };
}

// v20: 页脚"安全支付由 XX 提供"跟着当前 tab 走——
// 用户付稳定币时只显示 NOWPayments，付银行卡时只显示 Stripe，
// 不在稳定币付款时把法币通道的机构也列出来（用户分不清到底谁在处理这笔钱）。
// 单通道页面（非聚合）页脚本来就只写一家，不用动。
var ROUTED = ${routed ? 'true' : 'false'};
function setSecureNote(rail) {
  var el = document.getElementById('secureNote');
  if (!el || !ROUTED) return;
  el.textContent = rail === 'stablecoin'
    ? '安全支付由 NOWPayments 提供 · 技术支持 Jirvs'
    : '安全支付由 Stripe 提供 · 技术支持 Jirvs';
}
function pickCard() {
  clearTimers();
  if (tabCard) tabCard.classList.add('active');
  if (tabStable) tabStable.classList.remove('active');
  if (paneCard) paneCard.style.display = '';
  if (paneStable) paneStable.style.display = 'none';
  payBtn.style.display = '';
  setSecureNote('card');
}
function pickStable() {
  if (!tabStable || !paneStable) return;
  tabStable.classList.add('active');
  if (tabCard) tabCard.classList.remove('active');
  paneStable.style.display = '';
  if (paneCard) paneCard.style.display = 'none';
  payBtn.style.display = 'none';
  setErr('');
  setSecureNote('stablecoin');
  if (routed) requestDeposit();
}
if (tabCard) tabCard.onclick = pickCard;
if (tabStable) tabStable.onclick = pickStable;

async function doPay(rail) {
  payBtn.disabled = true; payBtn.textContent = '处理中…';
  try {
    var endpoint = rail === 'card'
      ? '/api/v1/checkout/sessions/' + sid + '/card/checkout'
      : '/api/v1/checkout/sessions/' + sid + '/simulate-success';
    var r = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rail: rail })
    });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || '支付失败');
    if (rail === 'card' && d.checkout_url) { location.href = d.checkout_url; return; }
    var p = d.payment || {};
    var qs = '/success.html?session_id=' + sid + '&payment_id=' + p.payment_id + '&rail=' + rail
      + '&method=' + encodeURIComponent(p.method || (rail === 'stablecoin' ? '稳定币' : '银行卡'));
    location.href = qs + '&return_url=' + encodeURIComponent(returnUrl);
  } catch (err) {
    setErr(err.message);
    payBtn.disabled = false; payBtn.textContent = '确认支付';
    if (routed && rail === 'stablecoin') payBtn.style.display = 'none';
  }
}
payBtn.onclick = function () {
  var rail = (tabStable && tabStable.classList.contains('active')) ? 'stablecoin' : 'card';
  doPay(rail);
};
if (SHOW_STABLE) initStablecoin().then(function () {
  if (!INIT_STABLE) return;
  if (tabStable) { pickStable(); return; }
  payBtn.style.display = 'none';
  if (routed) requestDeposit();
});
</script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`支付服务已启动: http://localhost:${PORT}`);
  console.log(`法币通道: Stripe Connect + Stripe Checkout（需配置 STRIPE_SECRET_KEY）`);
  console.log(`通道 nowpayments（稳定币）: ${process.env.NOWPAYMENTS_MOCK === 'true' ? 'mock（内存模拟，单元测试用）' : 'live（NOWPayments 真实接口）'}`);
  console.log(`演示页: http://localhost:${PORT}/`);
});
