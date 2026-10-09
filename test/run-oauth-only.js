// v21.7.3: Stripe Connect OAuth 专项测试（stub fetch，不调真实 Stripe）。
process.env.STRIPE_SECRET_KEY = 'sk_test_oauth_only';
process.env.STRIPE_CLIENT_ID = 'ca_test_oauth_123';
process.env.OAUTH_STATE_SECRET = 'test_state_secret_0123456789abcdef';

const crypto = require('crypto');
const { createAdapter } = require('../src/stripeAdapter.js');

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL ' + name); }
};

(async () => {
  const a = createAdapter();

  // ---- 授权 URL ----
  const url = a.getOAuthAuthorizeUrl({ redirect_uri: 'https://portal.jirvs.com/api/v1/oauth/stripe/callback', state: 'st_1' });
  ok('授权地址是 connect.stripe.com', url.startsWith('https://connect.stripe.com/oauth/authorize?'));
  ok('带 response_type=code', url.includes('response_type=code'));
  ok('带 client_id', url.includes('client_id=ca_test_oauth_123'));
  ok('带 scope=read_write', url.includes('scope=read_write'));
  ok('带 redirect_uri', url.includes(encodeURIComponent('https://portal.jirvs.com/api/v1/oauth/stripe/callback')));
  ok('带 state', url.includes('state=st_1'));

  delete process.env.STRIPE_CLIENT_ID;
  try { createAdapter().getOAuthAuthorizeUrl({ redirect_uri: 'x', state: 'y' }); ok('缺 STRIPE_CLIENT_ID 时报错', false); }
  catch (e) { ok('缺 STRIPE_CLIENT_ID 时报错', /STRIPE_CLIENT_ID/.test(e.message)); }
  process.env.STRIPE_CLIENT_ID = 'ca_test_oauth_123';

  // ---- state 签名 ----
  const a2 = createAdapter();
  const st = a2.signOAuthState('mch_abc', 'user_1');
  const rec = a2.verifyOAuthState(st);
  ok('state 签验 roundtrip', rec && rec.merchant_id === 'mch_abc' && rec.user_id === 'user_1');
  ok('state 含点号的商户 ID（邮箱）可验', (() => {
    const s2 = a2.signOAuthState('test.user@example.com', 'user_1');
    const r2 = a2.verifyOAuthState(s2);
    return r2 && r2.merchant_id === 'test.user@example.com';
  })());
  ok('篡改 state 被拒绝', a2.verifyOAuthState(st.slice(0, -2) + 'xx') === null);
  ok('空 state 被拒绝', a2.verifyOAuthState('') === null);
  ok('过期 state 被拒绝', (() => {
    const payload = Buffer.from(JSON.stringify({ m: 'm1', u: 'u1', t: Date.now() - 20 * 60 * 1000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET).update(payload).digest('hex');
    return a2.verifyOAuthState(`${payload}.${sig}`) === null;
  })());
  ok('换密钥后旧 state 失效', (() => {
    process.env.OAUTH_STATE_SECRET = 'another_secret';
    const r = createAdapter().verifyOAuthState(st);
    process.env.OAUTH_STATE_SECRET = 'test_state_secret_0123456789abcdef';
    return r === null;
  })());

  // ---- code 换 token ----
  const a3 = createAdapter();
  let gotUrl, gotBody;
  const mockToken = (obj) => {
    global.fetch = async (u, o) => {
      gotUrl = u; gotBody = o.body;
      return { ok: true, text: async () => JSON.stringify(obj) };
    };
  };
  mockToken({ stripe_user_id: 'acct_1', scope: 'read_write', livemode: false });
  const t = await a3.exchangeOAuthCode({ code: 'ac_123', redirect_uri: 'https://portal.jirvs.com/api/v1/oauth/stripe/callback' });
  ok('换 token 打到 oauth/token', gotUrl === 'https://connect.stripe.com/oauth/token');
  ok('grant_type=authorization_code', String(gotBody).includes('grant_type=authorization_code'));
  ok('带 client_secret', String(gotBody).includes('client_secret=sk_test_oauth_only'));
  ok('返回 account_id', t.account_id === 'acct_1');
  ok('测试模式识别', t.mode === 'test');

  try { await a3.exchangeOAuthCode({ code: '', redirect_uri: 'x' }); ok('缺 code 时报错', false); }
  catch (e) { ok('缺 code 时报错', /授权码/.test(e.message)); }

  mockToken({ stripe_user_id: 'acct_1', scope: 'read_only', livemode: false });
  try { await a3.exchangeOAuthCode({ code: 'c', redirect_uri: 'x' }); ok('scope 不足时报错', false); }
  catch (e) { ok('scope 不足时报错', /授权范围/.test(e.message)); }

  mockToken({ stripe_user_id: 'acct_1', scope: 'read_write', livemode: true });
  try { await a3.exchangeOAuthCode({ code: 'c', redirect_uri: 'x' }); ok('livemode 不一致时报错', false); }
  catch (e) { ok('livemode 不一致时报错', /模式/.test(e.message)); }

  mockToken({ scope: 'read_write', livemode: false });
  try { await a3.exchangeOAuthCode({ code: 'c', redirect_uri: 'x' }); ok('缺 stripe_user_id 时报错', false); }
  catch (e) { ok('缺 stripe_user_id 时报错', /stripe_user_id/.test(e.message)); }

  // ---- deauthorize ----
  let deUrl, deBody;
  global.fetch = async (u, o) => { deUrl = u; deBody = o.body; return { ok: true, text: async () => '{}' }; };
  const deOk = await a3.deauthorizeOAuthAccount('acct_1');
  ok('deauthorize 打对地址', deUrl === 'https://connect.stripe.com/oauth/deauthorize');
  ok('deauthorize 带 stripe_user_id', String(deBody).includes('stripe_user_id=acct_1'));
  ok('deauthorize 成功返回 true', deOk === true);
  global.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad' });
  ok('deauthorize 失败返回 false（不抛）', (await a3.deauthorizeOAuthAccount('acct_1')) === false);

  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : `FAILED: ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
