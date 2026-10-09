// Stripe 适配器：Stripe Connect Express + Stripe Checkout。
// 平台只保存 connected account ID 和状态，不保存银行卡或身份资料。
// 真实密钥通过 STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET 注入环境变量。

const crypto = require('crypto');

const API_BASE = 'https://api.stripe.com/v1';

function formEncode(value, prefix, out = []) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => formEncode(v, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => formEncode(v, `${prefix}[${k}]`, out));
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
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`Stripe API 调用失败 (${res.status}): ${data?.error?.message || text || '未知错误'}`);
    return data;
  }

  // v21.7: v2 API（JSON），用于 Connect 子账户（v1 type=express 已被 Stripe 停用）
  const API_V2 = 'https://api.stripe.com/v2';
  async function apiFetchV2(path, { method = 'GET', json = null } = {}) {
    if (!secretKey) throw new Error('Stripe 未配置 STRIPE_SECRET_KEY');
    const res = await fetch(`${API_V2}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`Stripe v2 API 调用失败 (${res.status}): ${data?.error?.message || text || '未知错误'}`);
    return data;
  }

  async function createConnectedAccount({ country, email, business_name, refresh_url, return_url }) {
    // v2: merchant 配置 + dashboard:none，费用/损失由子账户承担，Jirvs 拿 0
    const account = await apiFetchV2('/core/accounts', {
      method: 'POST',
      json: {
        contact_email: String(email || ''),
        display_name: String(business_name || email || 'Merchant').slice(0, 200),
        identity: { country: String(country || 'HK').toUpperCase() },
        configuration: { merchant: {} },
        dashboard: 'none',
        defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      },
    });
    const link = await createAccountLink(account.id, { refresh_url, return_url });
    const st = await getConnectedAccount(account.id);
    return {
      account_id: account.id,
      charges_enabled: isConnectReady(st),
      payouts_enabled: false,
      details_submitted: false,
      onboarding_url: link.url,
      mode: secretKey.startsWith('sk_test_') ? 'test' : 'live',
    };
  }

  function isConnectReady(acct) {
    const mc = (acct.configuration || {}).merchant || {};
    const reqs = acct.requirements;
    const noReqs = !reqs || (Array.isArray(reqs) && !reqs.length) || (typeof reqs === 'object' && !Object.keys(reqs).length);
    return !!mc.applied && noReqs;
  }

  async function createAccountLink(account_id, { refresh_url, return_url }) {
    return apiFetchV2('/core/account_links', {
      method: 'POST',
      json: {
        account: account_id,
        use_case: { type: 'account_onboarding', account_onboarding: { refresh_url, return_url } },
      },
    });
  }

  async function getConnectedAccount(account_id) {
    const acct = await apiFetchV2(`/core/accounts/${encodeURIComponent(account_id)}?include[]=configuration.merchant`);
    // 归一化为 v1 风格字段，方便上层判断
    return { ...acct, charges_enabled: isConnectReady(acct), payouts_enabled: false, details_submitted: isConnectReady(acct) };
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
      'payment_method_types[0]': 'card',
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
    verifySignature(raw, signature, webhookSecret);
    const event = JSON.parse(raw);
    const obj = event.data?.object || {};
    const type = String(event.type || '').toLowerCase();
    const succeeded = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(type)
      || (type === 'payment_intent.succeeded');
    const failed = ['checkout.session.expired', 'checkout.session.async_payment_failed', 'payment_intent.payment_failed'].includes(type);
    return {
      event_id: event.id || '',
      type: succeeded ? 'payment.succeeded' : failed ? (type.includes('expired') ? 'payment.canceled' : 'payment.failed') : 'payment.updated',
      raw_type: type,
      payment_id: obj.id || obj.payment_intent || '',
      order_id: obj.metadata?.order_id || obj.client_reference_id || '',
      merchant_id: obj.metadata?.merchant_id || '',
      amount: obj.amount_total != null ? obj.amount_total / 100 : (obj.amount_received != null ? obj.amount_received / 100 : null),
      currency: String(obj.currency || '').toLowerCase(),
      status: succeeded ? 'succeeded' : failed ? (type.includes('expired') ? 'canceled' : 'failed') : 'processing',
      stripe_account: event.account || '',
    };
  }

  return {
    gateway: 'stripe',
    isConfigured: () => !!secretKey,
    isSandbox: () => secretKey.startsWith('sk_test_'),
    createConnectedAccount,
    createAccountLink,
    getConnectedAccount,
    isConnectReady,
    createPayment,
    getPayment,
    cancelPayment,
    getCheckoutSession,
    parseWebhook,
  };
}

module.exports = { createAdapter, minorAmount, verifySignature };
