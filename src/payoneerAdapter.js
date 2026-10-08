// Payoneer 适配器：把 Payoneer 的接口差异封装在这一层，对外暴露
// 统一支付语义（createPayment / getPayment / cancelPayment / createRefund /
// createCheckoutSession / getCheckoutSession / parseWebhook ...），
// 这样 server.js 只需按 rail（card=银行卡→Payoneer / stablecoin=稳定币→NOWPayments）
// 选择适配器，用户永远不选机构。
//
// 接口形状依据 Payoneer 公开文档（Checkout Server Payment API v2.38.0）：
//   - 沙盒地址: https://api.sandbox.oscato.com/api
//   - 生产地址: https://api.live.oscato.com/api
//   - 认证: Basic（merchant code 作用户名，payment token 作密码）
//   - 建支付会话: POST /lists，body 为 Transaction
//       { transactionId, integration: "HOSTED", operationType: "CHARGE",
//         division, country, customer, payment: { amount, currency, reference },
//         callback: { returnUrl, cancelUrl, notificationUrl } }
//   - 查会话: GET /lists/{longId}
//
// 沙盒模式（未配置 PAYONEER_MERCHANT_CODE / PAYONEER_PAYMENT_TOKEN，
// 或 SANDBOX_MODE=true）下返回模拟数据，不调用真实接口。
// 真实模式目前仅实现 createCheckoutSession / getCheckoutSession（按文档直调），
// 其余操作在拿到合作伙伴凭证并联调通过前会明确报错，不会悄悄走错路。

const crypto = require('crypto');

const SANDBOX_BASE = 'https://api.sandbox.oscato.com/api';
const LIVE_BASE = 'https://api.live.oscato.com/api';

// Payoneer 会话/支付状态 -> 平台统一状态
function mapStatus(s) {
  const map = {
    pending: 'requires_payment_method',
    requires_payment_method: 'requires_payment_method',
    processing: 'processing',
    succeeded: 'succeeded',
    failed: 'failed',
    canceled: 'canceled',
    expired: 'canceled',
  };
  return map[String(s).toLowerCase()] || s;
}

function createAdapter() {
  const merchantCode = process.env.PAYONEER_MERCHANT_CODE || '';
  const paymentToken = process.env.PAYONEER_PAYMENT_TOKEN || '';
  const sandbox = !merchantCode || !paymentToken || process.env.SANDBOX_MODE === 'true';
  const baseUrl = sandbox ? SANDBOX_BASE : LIVE_BASE;
  const division = process.env.PAYONEER_DIVISION || '';

  // 沙盒内存存储（真实模式下以 Payoneer 为准）
  const charges = new Map();  // payment_id -> 统一支付对象
  const lists = new Map();    // session_id -> LIST 会话
  const accounts = new Map(); // account_id -> 模拟子商户
  const rid = (prefix) => `${prefix}_sandbox_${crypto.randomBytes(8).toString('hex')}`;
  const now = () => new Date().toISOString();

  function authHeader() {
    return 'Basic ' + Buffer.from(`${merchantCode}:${paymentToken}`).toString('base64');
  }

  async function apiFetch(path, { method = 'GET', body } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/vnd.optile.payment.enterprise-v1-extensible+json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 直接透传 */ }
    if (!res.ok) {
      const msg = (data && (data.message || data.resultInfo)) || text || `HTTP ${res.status}`;
      throw new Error(`Payoneer 接口调用失败: ${msg}`);
    }
    return data;
  }

  // ---- 统一支付语义（沙盒模拟） ----

  // Payoneer 的服务端模型以 LIST 会话为中心：createPayment 在沙盒里
  // 创建一笔支付 + 关联一个 LIST 会话，checkout_url 指向模拟托管页，
  // 演示时点开即可走完 付款→成功 全链路。
  async function createPayment({ merchant_id, order_id, amount, currency, description, payoneer_account, success_url, cancel_url }) {
    if (!payoneer_account) throw new Error('payoneer_account 为必填项：商户须先完成 Payoneer 开户');
    if (sandbox) {
      const session = mockListSession({ merchant_id, order_id, amount, currency, description, payoneer_account, success_url, cancel_url });
      // 复用会话关联的支付记录（同一笔钱只有一个 payment_id）
      const payment = {
        ...charges.get(session.payment_id),
        checkout_url: session.checkout_url,
        description: description || '',
      };
      charges.set(payment.payment_id, payment);
      return { ...payment, note: '沙盒模式：未调用 Payoneer 真实接口' };
    }
    // 真实模式：Payoneer 服务端模型即 LIST 会话，复用下单逻辑
    const s = await createCheckoutSession({ merchant_id, order_id, amount, currency, description, success_url, cancel_url, payoneer_account });
    return {
      payment_id: s.payment_id || s.session_id,
      session_id: s.session_id,
      order_id, merchant_id,
      amount: Number(amount), currency: String(currency).toLowerCase(),
      status: 'requires_payment_method',
      checkout_url: s.checkout_url,
      description: description || '',
      payoneer_account,
      gateway: 'payoneer',
      mode: 'live',
      created_at: now(),
    };
  }

  function mockListSession({ merchant_id, order_id, amount, currency, description, payoneer_account, success_url, cancel_url }) {
    const session_id = rid('list');
    const payment_id = rid('ch');
    const session = {
      session_id,
      longId: session_id, // 对标 Payoneer LIST 会话的 longId
      checkout_url: `/sandbox-checkout/${session_id}`,
      order_id,
      merchant_id,
      amount: Number(amount),
      currency: String(currency).toLowerCase(),
      description: description || '',
      status: 'pending', // pending -> succeeded / canceled
      payment_id,
      payoneer_account: payoneer_account || '',
      success_url: success_url || '',
      cancel_url: cancel_url || '',
      gateway: 'payoneer',
      mode: 'sandbox',
      rail: 'card', // v10: Payoneer 通道目前仅支持银行卡/本地支付方式
      created_at: now(),
    };
    lists.set(session_id, session);
    // 关联一笔待支付记录，成功页与事件口径统一
    charges.set(payment_id, {
      payment_id, session_id, order_id, merchant_id,
      amount: Number(amount), currency: String(currency).toLowerCase(),
      status: 'requires_payment_method',
      payoneer_account: payoneer_account || '',
      gateway: 'payoneer', mode: 'sandbox', created_at: session.created_at,
    });
    return session;
  }

  async function createCheckoutSession({ merchant_id, order_id, amount, currency, description, success_url, cancel_url, payoneer_account }) {
    if (!payoneer_account) throw new Error('payoneer_account 为必填项：商户须先完成 Payoneer 开户');
    if (sandbox) {
      const s = mockListSession({ merchant_id, order_id, amount, currency, description, payoneer_account, success_url, cancel_url });
      return { ...s, note: '沙盒模式：未调用 Payoneer 真实接口' };
    }
    // 真实模式：按 Checkout Server Payment API 文档直调 POST /lists
    const body = {
      transactionId: String(order_id),
      integration: 'HOSTED',
      operationType: 'CHARGE',
      ...(division ? { division } : {}),
      customer: {},
      payment: {
        amount: Number(amount),
        currency: String(currency).toUpperCase(),
        reference: description || String(order_id),
      },
      callback: {
        ...(success_url ? { returnUrl: success_url } : {}),
        ...(cancel_url ? { cancelUrl: cancel_url } : {}),
      },
    };
    const data = await apiFetch('/lists', { method: 'POST', body });
    const longId = data.longId || data.id || '';
    const links = data.links || {};
    return {
      session_id: longId,
      longId,
      checkout_url: (links.redirect || links.self || ''),
      order_id, merchant_id,
      amount: Number(amount),
      currency: String(currency).toLowerCase(),
      status: 'pending',
      payment_id: '',
      payoneer_account,
      gateway: 'payoneer',
      mode: 'live',
      created_at: now(),
    };
  }

  async function getPayment(payment_id) {
    if (sandbox) {
      const p = charges.get(payment_id);
      if (!p) throw new Error('支付不存在: ' + payment_id);
      return { ...p };
    }
    throw new Error('Payoneer 真实环境联调待完成：查询单笔支付需合作伙伴凭证获批后验证');
  }

  async function cancelPayment(payment_id) {
    if (sandbox) {
      const p = charges.get(payment_id);
      if (!p) throw new Error('支付不存在: ' + payment_id);
      p.status = 'canceled';
      const s = lists.get(p.session_id);
      if (s) s.status = 'canceled';
      return { ...p };
    }
    throw new Error('Payoneer 真实环境联调待完成：取消支付需合作伙伴凭证获批后验证');
  }

  // v21.6：删除 createRefund——Jirvs 不发起任何资金划转（含退款），退款请商户去机构后台操作。

  async function getCheckoutSession(session_id) {
    if (sandbox) {
      const s = lists.get(session_id);
      if (!s) throw new Error('收银台会话不存在: ' + session_id);
      return { ...s, status: mapStatus(s.status) === 'succeeded' ? 'complete' : s.status };
    }
    const data = await apiFetch(`/lists/${encodeURIComponent(session_id)}`);
    return {
      session_id: data.longId || session_id,
      longId: data.longId || session_id,
      checkout_url: '',
      status: data.result === 'PROCEED' ? 'pending' : String(data.result || '').toLowerCase(),
      gateway: 'payoneer',
      mode: 'live',
    };
  }

  // 仅沙盒：模拟用户在托管页完成支付
  function simulateCheckoutSuccess(session_id) {
    const s = lists.get(session_id);
    if (!s) throw new Error('收银台会话不存在: ' + session_id);
    s.status = 'succeeded';
    const p = charges.get(s.payment_id);
    if (p) p.status = 'succeeded';
    return { session: { ...s }, payment: p ? { ...p } : null };
  }

  // 仅沙盒：模拟用户完成支付（直接支付 API）
  function simulateSuccess(payment_id) {
    const p = charges.get(payment_id);
    if (!p) throw new Error('支付不存在: ' + payment_id);
    p.status = 'succeeded';
    const s = lists.get(p.session_id);
    if (s) s.status = 'succeeded';
    return { ...p };
  }

  // ---- 商户开户（沙盒模拟） ----
  // 真实模式下 Payoneer 商户入驻走合作伙伴审批 + KYB，此处沙盒模拟整套流程：
  // 创建子商户（待验证）-> 模拟 KYB 页提交 -> charges_enabled=true
  async function createConnectedAccount({ country, email, base_url }) {
    if (sandbox) {
      const account_id = 'pmch_sandbox_' + crypto.randomBytes(8).toString('hex');
      const acct = {
        account_id,
        country: country || 'HK',
        email: email || '',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        onboarding_url: `${base_url || ''}/sandbox-onboarding-payoneer/${account_id}`,
        refresh_url: '',
        return_url: '',
        created_at: now(),
      };
      accounts.set(account_id, acct);
      return { ...acct, note: '沙盒模式：模拟的 Payoneer 子商户' };
    }
    throw new Error('Payoneer 真实环境联调待完成：商户开户需合作伙伴审批通过后验证');
  }

  async function createOnboardingLink(account_id, { refresh_url, return_url }) {
    if (sandbox) {
      const acct = accounts.get(account_id);
      if (!acct) throw new Error('子商户不存在: ' + account_id);
      acct.refresh_url = refresh_url || '';
      acct.return_url = return_url || '';
      return { url: acct.onboarding_url, note: '沙盒模式：模拟开户页' };
    }
    throw new Error('Payoneer 真实环境联调待完成');
  }

  async function getConnectedAccount(account_id) {
    if (sandbox) {
      const acct = accounts.get(account_id);
      if (!acct) throw new Error('子商户不存在: ' + account_id);
      return { ...acct };
    }
    throw new Error('Payoneer 真实环境联调待完成');
  }

  function getSandboxAccount(account_id) {
    const acct = accounts.get(account_id);
    if (!acct) throw new Error('子商户不存在: ' + account_id);
    return { ...acct };
  }

  // 仅沙盒：模拟商户在开户页提交资料完成 KYB
  function completeSandboxOnboarding(account_id, data = {}) {
    const acct = accounts.get(account_id);
    if (!acct) throw new Error('子商户不存在: ' + account_id);
    acct.details_submitted = true;
    acct.charges_enabled = true;
    acct.payouts_enabled = true;
    acct.kyc_data = { business_name: data.business_name || '', id_number: data.id_number ? '***' : '', bank_account: data.bank_account ? '***' : '' };
    acct.completed_at = now();
    return { ...acct };
  }

  // ---- Webhook ----
  // 真实模式下 Payoneer 通过建会话时传的 callback.notificationUrl 回调交易状态；
  // 沙盒用统一 JSON 模拟：{"type":"payment.succeeded","payment_id":"ch_sandbox_..."}
  async function parseWebhook(req) {
    if (sandbox) {
      let body;
      try {
        body = JSON.parse(req.body.toString());
      } catch {
        throw new Error('沙盒 Webhook 需要 JSON body，例如 {"type":"payment.succeeded","payment_id":"ch_sandbox_..."}');
      }
      return {
        type: body.type || 'payment.succeeded',
        payment_id: body.payment_id || '',
        order_id: body.order_id || '',
        merchant_id: body.merchant_id || '',
        amount: body.amount ?? null,
        currency: body.currency || '',
        raw_type: 'sandbox.simulated',
      };
    }
    throw new Error('Payoneer 真实环境联调待完成：Webhook 验签与事件映射需凭证获批后验证');
  }

  return {
    isSandbox: () => sandbox,
    gateway: 'payoneer',
    createPayment,
    getPayment,
    cancelPayment,
    createCheckoutSession,
    getCheckoutSession,
    simulateCheckoutSuccess,
    simulateSuccess,
    createConnectedAccount,
    createOnboardingLink,
    getConnectedAccount,
    getSandboxAccount,
    completeSandboxOnboarding,
    parseWebhook,
  };
}

module.exports = { createAdapter };
