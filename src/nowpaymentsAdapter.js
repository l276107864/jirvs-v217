// NOWPayments 适配器（v18）：稳定币收款通道，真实接口直调。
//
// 架构位置：Jirvs 统一 API 之下、NOWPayments 之上。商户在 NOWPayments 官网
// 自行开户并配置自己的收款钱包（Outcome Wallet），在 Jirvs 商户门户绑定
// 自己的 API Key + IPN Secret；Jirvs 服务端用该 Key 代商户建单、收 IPN
// 回调、记账，全程不碰资金。
//
// 官方要点（以 https://documenter.getpostman.com/view/7907941/S1a32n38 为准）：
//   - 认证：请求头 x-api-key
//   - 建单：POST /v1/payment { price_amount, price_currency, pay_currency,
//     order_id, order_description, ipn_callback_url }
//   - 查单：GET /v1/payment/:payment_id
//   - 只读校验：GET /v1/balance（绑定商户 Key 时用，不碰钱）
//   - IPN：回调 Header 带 x-nowpayments-sig；验签 = 顶层 key 排序后的
//     JSON.stringify(params, Object.keys(params).sort()) 做 HMAC-SHA512，
//     与 Header 的 hex 值比对（timingSafeEqual）。
//   - 官方沙盒已下线（2026-09-29 官方支持确认），本适配器无沙盒模式；
//     单元测试用 NOWPAYMENTS_MOCK=true 走内存模拟，不碰网络。
//
// pay_currency 代码说明：
//   以下映射为 NOWPayments 公开资料中的常用代码；USDT→Tron(usdttrc20) 与
//   USDC→Solana(usdcsol) 为默认链，确信度最高。其余组合以联调时
//   GET /v1/currencies 实际返回为准——若建单时 NOWPayments 报
//   pay_currency 非法，deposit 接口会把原文透出，便于对照修正。

const crypto = require('crypto');

const API_BASE = process.env.NOWPAYMENTS_API_BASE || 'https://api.nowpayments.io/v1';

// v17 既定：USDT 默认 Tron，USDC 默认 Solana（海宝拍板，不改）
const SUPPORTED_TOKENS = [
  { token: 'USDT', networks: ['Tron', 'Ethereum', 'Polygon', 'Arbitrum', 'Solana'], default_network: 'Tron' },
  { token: 'USDC', networks: ['Solana', 'Ethereum', 'Polygon', 'Arbitrum'], default_network: 'Solana' },
];

const PAY_CURRENCY_CODES = {
  'USDT/Tron': 'usdttrc20',
  'USDT/Ethereum': 'usdterc20',
  'USDT/Solana': 'usdtsol',
  'USDT/Polygon': 'usdtmatic',
  'USDT/Arbitrum': 'usdtarb',
  'USDC/Solana': 'usdcsol',
  'USDC/Ethereum': 'usdc',
  'USDC/Polygon': 'usdcmatic',
  'USDC/Arbitrum': 'usdcarb',
};

function supportedTokens() {
  return JSON.parse(JSON.stringify(SUPPORTED_TOKENS));
}

// 币种×网络 → NOWPayments pay_currency 代码；非法组合直接抛错（调用方转 400）
function resolvePayCurrency(token, network) {
  const t = String(token || '').trim().toUpperCase();
  const nRaw = String(network || '').trim();
  const spec = SUPPORTED_TOKENS.find((x) => x.token === t);
  const n = spec ? spec.networks.find((x) => x.toLowerCase() === nRaw.toLowerCase()) : null;
  if (!spec || !n) {
    throw new Error(`不支持的币种/网络组合: ${token} / ${network}（可用：USDT×Tron/Ethereum/Polygon/Arbitrum/Solana，USDC×Solana/Ethereum/Polygon/Arbitrum）`);
  }
  const code = PAY_CURRENCY_CODES[`${t}/${n}`];
  if (!code) throw new Error(`币种/网络组合 ${t}/${n} 的 NOWPayments 代码待联调确认`);
  return { token: t, network: n, pay_currency: code };
}

// NOWPayments payment_status → Jirvs 统一订单状态
function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  const map = {
    waiting: 'pending',        // 等待付款
    confirming: 'pending',      // 链上确认中
    confirmed: 'pending',       // 已确认、待结算
    sending: 'pending',         // 结算发送中
    finished: 'succeeded',     // 完成
    partially_paid: 'partially_paid', // 少付：不清零、不算成功，人工处理
    failed: 'failed',
    refunded: 'refunded',
    expired: 'expired',         // 过期未付
  };
  return map[v] || v;
}

// ---- IPN 验签（严格按官方规范） ----
// 官方 Node 示例：
//   const hmac = crypto.createHmac('sha512', ipnSecret);
//   hmac.update(JSON.stringify(params, Object.keys(params).sort()));
//   const signature = hmac.digest('hex');
// 与回调 Header x-nowpayments-sig 比对。
function signIpn(params, ipnSecret) {
  if (!params || typeof params !== 'object') throw new Error('IPN body 必须为对象');
  if (!ipnSecret) throw new Error('IPN Secret 未配置');
  const hmac = crypto.createHmac('sha512', String(ipnSecret));
  hmac.update(JSON.stringify(params, Object.keys(params).sort()));
  return hmac.digest('hex');
}

function verifyIpnSignature(params, signature, ipnSecret) {
  if (!signature) return false;
  let expected;
  try {
    expected = signIpn(params, ipnSecret);
  } catch {
    return false;
  }
  const a = Buffer.from(String(signature).trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- 凭证加密（商户 API Key / IPN Secret 只存密文） ----
// 密钥：CRED_ENC_KEY（64 位 hex）；未配置则每启动随机生成（重启后需重新绑定，仅本地测试用）。
const ENC_ALGO = 'aes-256-gcm';
function encKey() {
  const hex = process.env.CRED_ENC_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (!global.__jirvsEncKey) {
    global.__jirvsEncKey = crypto.randomBytes(32);
    console.warn('[nowpayments] CRED_ENC_KEY 未配置：本次启动使用临时加密密钥，重启后已绑定的商户凭证需重新绑定。');
  }
  return global.__jirvsEncKey;
}

function encryptSecret(plain) {
  const key = encKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') };
}

function decryptSecret(obj) {
  if (!obj || !obj.iv || !obj.tag || !obj.data) throw new Error('凭证密文格式错误');
  const key = encKey();
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(obj.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(obj.tag, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(obj.data, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// ---- 适配器 ----
// { apiKey, ipnSecret } 二选一必填其一：建单/查单需 apiKey；验签需 ipnSecret。
// NOWPAYMENTS_MOCK=true 时走内存模拟（单元测试用，不碰网络）。
function createAdapter({ apiKey = '', ipnSecret = '' } = {}) {
  const mock = process.env.NOWPAYMENTS_MOCK === 'true';
  const mockPayments = new Map(); // payment_id -> mock 支付对象
  const rid = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
  const now = () => new Date().toISOString();

  async function apiFetch(path, { method = 'GET', body } = {}) {
    if (!apiKey) throw new Error('NOWPayments API Key 未配置');
    const res = await fetch(API_BASE + path, {
      method,
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 透传 */ }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
      throw new Error(`NOWPayments 接口调用失败: ${msg}`);
    }
    return data;
  }

  // 只读连通性校验（绑定商户 Key 时用，不创建任何东西、不碰钱）
  async function checkConnection() {
    if (mock) {
      // 单元测试用：特定 key 模拟校验失败，覆盖“绑定失败回滚”路径
      if (apiKey === 'np_invalid_key_for_test') return { ok: false, mode: 'mock', error: 'invalid api key (mock)' };
      return { ok: true, mode: 'mock' };
    }
    const data = await apiFetch('/balance');
    return { ok: true, mode: 'live', balance: data };
  }

  // 商户已启用的币种（绑定成功后回显，便于对照）
  async function getMerchantCoins() {
    if (mock) return { ok: true, mode: 'mock', coins: ['usdttrc20', 'usdcsol'] };
    const data = await apiFetch('/merchant/coins');
    return { ok: true, mode: 'live', coins: (data && data.selectedCurrencies) || data };
  }

  // 建单：Jirvs 订单（法币计价）→ NOWPayments 支付单（返回真实收款地址与应付币数）
  async function createPayment({ order_id, amount, currency, token, network, description, ipn_callback_url }) {
    const { token: t, network: n, pay_currency } = resolvePayCurrency(token, network);
    if (mock) {
      const payment_id = rid('np');
      const p = {
        payment_id,
        pay_address: 'TMock' + crypto.randomBytes(14).toString('hex'),
        pay_amount: Number(amount), // mock 下 1:1，便于测试不断言汇率
        pay_currency,
        price_amount: Number(amount),
        price_currency: String(currency).toLowerCase(),
        order_id: String(order_id),
        order_description: description || '',
        payment_status: 'waiting',
        token: t, network: n,
        created_at: now(),
      };
      mockPayments.set(payment_id, p);
      return { ...p, status: mapStatus(p.payment_status), gateway: 'nowpayments', rail: 'stablecoin', mode: 'mock' };
    }
    const body = {
      price_amount: Number(amount),
      price_currency: String(currency).toLowerCase(),
      pay_currency,
      order_id: String(order_id),
      order_description: description || String(order_id),
      ...(ipn_callback_url ? { ipn_callback_url } : {}),
    };
    const data = await apiFetch('/payment', { method: 'POST', body });
    return {
      payment_id: String(data.payment_id),
      pay_address: data.pay_address,
      pay_amount: data.pay_amount,
      pay_currency: data.pay_currency,
      price_amount: data.price_amount,
      price_currency: data.price_currency,
      order_id: String(data.order_id || order_id),
      payment_status: data.payment_status,
      status: mapStatus(data.payment_status),
      token: t, network: n,
      gateway: 'nowpayments', rail: 'stablecoin', mode: 'live',
      created_at: data.created_at || now(),
    };
  }

  // 查单（IPN 未到 / 延迟时的兜底）
  async function getPayment(payment_id) {
    if (mock) {
      const p = mockPayments.get(String(payment_id));
      if (!p) throw new Error('支付不存在: ' + payment_id);
      return { ...p, status: mapStatus(p.payment_status) };
    }
    const data = await apiFetch(`/payment/${encodeURIComponent(payment_id)}`);
    return {
      payment_id: String(data.payment_id),
      pay_address: data.pay_address,
      pay_amount: data.pay_amount,
      actually_paid: data.actually_paid,
      pay_currency: data.pay_currency,
      price_amount: data.price_amount,
      price_currency: data.price_currency,
      order_id: String(data.order_id || ''),
      payment_status: data.payment_status,
      status: mapStatus(data.payment_status),
      outcome_amount: data.outcome_amount,
      outcome_currency: data.outcome_currency,
      gateway: 'nowpayments', rail: 'stablecoin', mode: 'live',
      created_at: data.created_at, updated_at: data.updated_at,
    };
  }

  // 仅 mock：推进模拟支付状态（单元测试用）
  function mockSetStatus(payment_id, payment_status) {
    const p = mockPayments.get(String(payment_id));
    if (!p) throw new Error('支付不存在: ' + payment_id);
    p.payment_status = payment_status;
    return { ...p };
  }

  // IPN 回调解析：验签 → 映射为统一事件；验签失败直接抛错（调用方回 400）
  function parseIpn(rawBody, signature) {
    let params;
    try {
      params = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch {
      throw new Error('IPN body 不是合法 JSON');
    }
    if (!verifyIpnSignature(params, signature, ipnSecret)) {
      throw new Error('IPN 签名校验失败，已丢弃');
    }
    const status = mapStatus(params.payment_status);
    const type = status === 'succeeded' ? 'payment.succeeded'
      : status === 'partially_paid' ? 'payment.partially_paid'
      : status === 'failed' ? 'payment.failed'
      : status === 'expired' ? 'payment.expired'
      : status === 'refunded' ? 'payment.refunded'
      : 'payment.updated';
    return {
      type,
      payment_id: String(params.payment_id || ''),
      order_id: String(params.order_id || ''),
      payment_status: params.payment_status || '',
      status,
      pay_amount: params.pay_amount,
      actually_paid: params.actually_paid,
      pay_currency: params.pay_currency || '',
      price_amount: params.price_amount,
      price_currency: params.price_currency || '',
      raw_type: 'nowpayments.ipn',
    };
  }

  return {
    gateway: 'nowpayments',
    isMock: () => mock,
    hasApiKey: () => !!apiKey,
    checkConnection,
    getMerchantCoins,
    createPayment,
    getPayment,
    mockSetStatus,
    parseIpn,
    verifyIpnSignature: (params, sig) => verifyIpnSignature(params, sig, ipnSecret),
    signIpn: (params) => signIpn(params, ipnSecret),
  };
}

module.exports = {
  createAdapter,
  supportedTokens,
  resolvePayCurrency,
  mapStatus,
  signIpn,
  verifyIpnSignature,
  encryptSecret,
  decryptSecret,
  PAY_CURRENCY_CODES,
};
