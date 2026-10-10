// Stripe 适配器：Stripe Connect Express + Stripe Checkout。
// 平台只保存 connected account ID 和状态，不保存银行卡或身份资料。
// 真实密钥通过 STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET 注入环境变量。

const crypto = require('crypto');

const API_BASE = 'https://api.stripe.com/v1';

function formEncode(value, prefix, out = []) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => formEncode(v, prefix ? `${prefix}[${i}]` : `${i}`, out));
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => formEncode(v, prefix ? `${prefix}[${k}]` : k, out));
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

function minorAmount(amount, currency) {
  const zeroDecimal = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
  const c = String(currency || 'usd').toLowerCase();
  const digits = zeroDecimal.has(c) ? 0 : 2;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount 必须是大于 0 的有效数字');
  return Math.round(n * (10 ** digits));
}

function verifySignature(raw, signature, secret, tolerance = 300) {
  if (!secret) throw new Error('Stripe Webhook 未配置 STRIPE_WEBHOOK_SECRET');
  const parts = String(signature || '').split(',');
  const timestamp = Number((parts.find((p) => p.startsWith('t=')) || '').slice(2));
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || !signatures.length) throw new Error('Stripe-Signature 缺失或格式错误');
  if (Math.abs(Date.now() / 1000 - timestamp) > tolerance) throw new Error('Stripe Webhook 时间戳已过期');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  const ok = signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw new Error('Stripe Webhook 签名校验失败');
}

function createAdapter() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();

  // v21.7.3: Stripe 请求统一 15 秒超时（token 换取不重试：授权码一次性，重试会烧掉 code）。
  async function fetchWithTimeout(url, opts = {}, ms = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`Stripe 请求超时（${ms}ms）`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  async function apiFetch(path, { method = 'GET', params = {}, account } = {}) {
    const body = method === 'GET' ? undefined : formEncode(params).join('&');
    const url = method === 'GET' && Object.keys(params).length
      ? `${API_BASE}${path}?${formEncode(params).join('&')}`
      : `${API_BASE}${path}`;
    if (!secretKey) throw new Error('Stripe 未配置 STRIPE_SECRET_KEY');
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(account ? { 'Stripe-Account': account } : {}),
    };
    const res = await fetchWithTimeout(url, { method, headers, body });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`Stripe API 调用失败 (${res.status}): ${data?.error?.message || text || '未知错误'}`);
    return data;
  }

  // v21.7.3: OAuth state 无状态 HMAC 签名（替代进程内 Map）。
  // 多实例/负载均衡/进程重启下依然可验；"一次性"由服务端已消费集合保证（见 server.js）。
  const OAUTH_STATE_TTL = 15 * 60 * 1000;
  function oauthStateSecret() {
    return String(process.env.OAUTH_STATE_SECRET || secretKey || '').trim();
  }
  function signOAuthState(merchant_id, user_id) {
    if (!oauthStateSecret()) throw new Error('未配置 OAuth state 签名密钥');
    const payload = Buffer.from(JSON.stringify({ m: String(merchant_id), u: String(user_id), t: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', oauthStateSecret()).update(payload).digest('hex');
    return `${payload}.${sig}`;
  }
  function verifyOAuthState(state) {
    try {
      const s = String(state || '');
      const i = s.lastIndexOf('.');
      if (i < 0 || !oauthStateSecret()) return null;
      const payload = s.slice(0, i);
      const sig = s.slice(i + 1);
      const expect = crypto.createHmac('sha256', oauthStateSecret()).update(payload).digest('hex');
      if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
      const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!o || !o.m || !o.u || !o.t || Date.now() - Number(o.t) > OAUTH_STATE_TTL) return null;
      return { merchant_id: o.m, user_id: o.u };
    } catch {
      return null;
    }
  }

  // v21.7.2: Stripe Connect OAuth 一键授权（取代 v2 建子账号）。
  // 商户点授权后跳 Stripe 官方页登录/注册并授权；Jirvs 不调接口替商户建账号、不碰身份资料。
  // 需要在 Stripe 后台 Connect 设置里拿到 OAuth client_id（配 STRIPE_CLIENT_ID 环境变量），
  // 并把回调地址登记为 Redirect URI。
  const OAUTH_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize';
  const OAUTH_TOKEN_URL = 'https://connect.stripe.com/oauth/token';

  function getOAuthClientId() {
    return String(process.env.STRIPE_CLIENT_ID || '').trim();
  }

  // 拼授权跳转地址；state 由调用方生成并校验（防 CSRF）。
  function getOAuthAuthorizeUrl({ redirect_uri, state }) {
    const clientId = getOAuthClientId();
    if (!clientId) throw new Error('Stripe 未配置 STRIPE_CLIENT_ID（请在 Stripe 后台 Connect 设置里获取 OAuth client_id）');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'read_write',
      redirect_uri: String(redirect_uri || ''),
      state: String(state || ''),
    });
    return `${OAUTH_AUTHORIZE_URL}?${q.toString()}`;
  }

  // 用授权码换 connected account ID（stripe_user_id）。
  // 校验：code 必填；scope 必须含 read_write；livemode 必须与平台 Key 模式一致。
  async function exchangeOAuthCode({ code, redirect_uri }) {
    const clientId = getOAuthClientId();
    if (!clientId) throw new Error('Stripe 未配置 STRIPE_CLIENT_ID');
    if (!secretKey) throw new Error('Stripe 未配置 STRIPE_SECRET_KEY');
    if (!String(code || '').trim()) throw new Error('缺少 Stripe 授权码');
    const body = new URLSearchParams({
      client_secret: secretKey,
      code: String(code || ''),
      grant_type: 'authorization_code',
    });
    if (redirect_uri) body.set('redirect_uri', String(redirect_uri));
    const res = await fetchWithTimeout(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString(),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`Stripe OAuth 换 token 失败 (${res.status}): ${data?.error_description || data?.error || text || '未知错误'}`);
    if (!data.stripe_user_id) throw new Error('Stripe OAuth 返回缺少 stripe_user_id');
    const scope = String(data.scope || '');
    if (!scope.split(/[,\s]+/).includes('read_write')) throw new Error('Stripe 授权范围不足（需要 read_write）');
    if (data.livemode !== undefined && !!data.livemode !== !secretKey.startsWith('sk_test_')) {
      throw new Error('Stripe 账号模式与平台不一致（测试/正式混用）');
    }
    return {
      account_id: data.stripe_user_id,
      livemode: !!data.livemode,
      scope,
      mode: secretKey.startsWith('sk_test_') ? 'test' : 'live',
    };
  }

  // 撤销 OAuth 授权（Stripe 端解绑）。尽力而为：失败只记日志，不阻断本地解绑。
  async function deauthorizeOAuthAccount(account_id) {
    const clientId = getOAuthClientId();
    if (!clientId || !secretKey || !account_id) return false;
    const body = new URLSearchParams({ client_id: clientId, stripe_user_id: String(account_id) });
    try {
      const res = await fetchWithTimeout('https://connect.stripe.com/oauth/deauthorize', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body.toString(),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`[stripe] deauthorize 失败 (${res.status}): ${text.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error('[stripe] deauthorize 异常:', e.message);
      return false;
    }
  }

  // 查 OAuth 连过来的账号状态（v1 接口 + 平台 Key 即可，无需 v2）。
  async function getOAuthAccountStatus(account_id) {
    const acct = await apiFetch(`/accounts/${encodeURIComponent(account_id)}`);
    return {
      id: acct.id,
      charges_enabled: !!acct.charges_enabled,
      payouts_enabled: !!acct.payouts_enabled,
      details_submitted: !!acct.details_submitted,
      requirements_currently_due: (acct.requirements && acct.requirements.currently_due) || [],
    };
  }

  async function createPayment({ connected_account_id, order_id, merchant_id, amount, currency, description, success_url, cancel_url, customer_email }) {
    const ccy = String(currency || 'USD').toLowerCase();
    const params = {
      mode: 'payment',
      'line_items[0][price_data][currency]': ccy,
      'line_items[0][price_data][unit_amount]': minorAmount(amount, ccy),
      'line_items[0][price_data][product_data][name]': String(description || `Jirvs 订单 ${order_id}`).slice(0, 500),
      'line_items[0][quantity]': 1,
      success_url: `${success_url || ''}${String(success_url || '').includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || '',
      // v9.2: 先只开卡和支付宝，微信支付要额外参数以后再加
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'alipay',
      client_reference_id: String(order_id),
      'metadata[order_id]': String(order_id),
      'metadata[merchant_id]': String(merchant_id),
      ...(customer_email ? { customer_email: String(customer_email) } : {}),
    };
    const session = await apiFetch('/checkout/sessions', { method: 'POST', params, account: connected_account_id });
    return {
      payment_id: session.id,
      session_id: session.id,
      checkout_url: session.url,
      order_id,
      merchant_id,
      amount: Number(amount),
      currency: ccy,
      status: session.payment_status === 'paid' ? 'succeeded' : 'requires_payment_method',
      gateway: 'stripe',
      mode: secretKey.startsWith('sk_test_') ? 'test' : 'live',
      stripe_account: connected_account_id,
      created_at: new Date().toISOString(),
    };
  }

  async function getCheckoutSession(session_id, connected_account_id) {
    const session = await apiFetch(`/checkout/sessions/${encodeURIComponent(session_id)}`, { account: connected_account_id });
    return normalizeSession(session, connected_account_id);
  }

  async function getPayment(payment_id, connected_account_id) {
    return getCheckoutSession(payment_id, connected_account_id);
  }

  async function cancelPayment(payment_id, connected_account_id) {
    const session = await apiFetch(`/checkout/sessions/${encodeURIComponent(payment_id)}/expire`, { method: 'POST', account: connected_account_id });
    return normalizeSession(session, connected_account_id);
  }

  function normalizeSession(session, connected_account_id) {
    return {
      payment_id: session.id,
      session_id: session.id,
      order_id: session.metadata?.order_id || session.client_reference_id || '',
      merchant_id: session.metadata?.merchant_id || '',
      amount: session.amount_total != null ? session.amount_total / 100 : 0,
      currency: String(session.currency || '').toLowerCase(),
      status: session.payment_status === 'paid' ? 'succeeded' : (session.status === 'expired' ? 'canceled' : 'requires_payment_method'),
      checkout_url: session.url || '',
      gateway: 'stripe',
      mode: secretKey.startsWith('sk_test_') ? 'test' : 'live',
      stripe_account: connected_account_id || '',
    };
  }

  function parseWebhook(raw, signature) {
    return parseWebhookWithSecret(raw, signature, webhookSecret);
  }

  function parseWebhookWithSecret(raw, signature, secret) {
    verifySignature(raw, signature, secret);
    const event = JSON.parse(raw);
    const obj = event.data?.object || {};
    const type = String(event.type || '').toLowerCase();
    const succeeded = (type === 'checkout.session.completed' && ['paid', 'no_payment_required'].includes(String(obj.payment_status || '')))
      || type === 'checkout.session.async_payment_succeeded'
      || type === 'payment_intent.succeeded';
    const failed = ['checkout.session.expired', 'checkout.session.async_payment_failed', 'payment_intent.payment_failed'].includes(type);
    return {
      event_id: event.id || '',
      type: succeeded ? 'payment.succeeded' : failed ? (type.includes('expired') ? 'payment.canceled' : 'payment.failed') : 'payment.updated',
      raw_type: type,
      payment_id: obj.id || obj.payment_intent || '',
      order_id: obj.metadata?.order_id || obj.client_reference_id || '',
      merchant_id: obj.metadata?.merchant_id || '',
      metadata: obj.metadata || {}, // v8: 订阅支付靠 metadata.subscription_id 识别
      amount: obj.amount_total != null ? obj.amount_total / 100 : (obj.amount_received != null ? obj.amount_received / 100 : null),
      currency: String(obj.currency || '').toLowerCase(),
      status: succeeded ? 'succeeded' : failed ? (type.includes('expired') ? 'canceled' : 'failed') : 'processing',
      amount_minor: obj.amount_total != null ? Number(obj.amount_total) : (obj.amount_received != null ? Number(obj.amount_received) : null),
      ignored: !succeeded && !failed,
      stripe_account: event.account || '',
    };
  }

  return {
    gateway: 'stripe',
    isConfigured: () => !!secretKey,
    isSandbox: () => secretKey.startsWith('sk_test_'),
    isOAuthConfigured: () => !!getOAuthClientId(),
    getOAuthClientId,
    getOAuthAuthorizeUrl,
    exchangeOAuthCode,
    deauthorizeOAuthAccount,
    getOAuthAccountStatus,
    signOAuthState,
    verifyOAuthState,
    createPayment,
    getPayment,
    cancelPayment,
    getCheckoutSession,
    parseWebhook,
    parseWebhookWithSecret,
  };
}

module.exports = { createAdapter, minorAmount, verifySignature };
