# v20 API 变更契约（给前端 B / 测试 C）

版本：0.20.0。最大变更：**商户门户加账号体系（邮箱+密码），数据进 SQLite 持久化；入驻第一步选通道；收银台按真实产品重做**。

## 0. 删了什么、为什么

- 公开 API 演示页（`/dev/pay.html` 公开访问）下掉：消费者正式产品里不能出现演示痕迹。改造成商户门户登录后开发者区的"接口调试台"。
- 公开 `/pay.html` 改为登录后可见：它是模拟商家网站的测试道具，不是给顾客的。
- 入驻"拒绝大陆主体"规则作废：法币通道大陆+香港主体均可注册。
- Antom 相关文案里的"国庆后上线"全部改为"待确认/待真实联调"：不做过度承诺。

## 1. 新增账号接口（4 个）

- `POST /api/v1/auth/register` body: `{ email, password }` → 200 `{ user }`（同时种登录 Cookie）
- `POST /api/v1/auth/login` / `POST /api/v1/auth/logout` / `GET /api/v1/auth/me`
- Cookie：`jirvs_session`，HttpOnly + SameSite=Lax，7 天；生产 HTTPS 下自动加 `Secure`（本地 http 不加）。
- 密码 scrypt 哈希；API Key 原值只显示一次，服务端只存 SHA-256 哈希。

## 2. 商户注册改了（POST /api/v1/merchants）

- body 新增必填 `channels`：`["fiat"]` / `["stablecoin"]` / 双选；旧的 `'stable'` 已统一为 `'stablecoin'`。
- `country` 不再拦大陆（CN 直接通过）。
- 返回仍只给一次 `api_key`（`jk_live_` 前缀）；列表/详情接口永远不返回 Key 明文与哈希。

## 3. 新增：重新生成 API Key

- `POST /api/v1/merchants/:id/api-key/rotate`（需登录 + 归属自己的商户）
- 旧 Key 立即失效；新 Key 只在本次响应返回一次；服务端仍只存哈希。
- 跨账号调用 404；未登录 401。

## 4. 收银台（/checkout/:id）

- Jirvs 品牌色：青绿 #3d8b85、金 #c48a3a、深藏青 #0e1420。
- "取消并返回"是带边框的真按钮；默认 cancel_url 改为 `history.back()`。
- 页脚随 tab 切换：银行卡→"安全支付由 Payoneer 提供 · 技术支持 Jirvs"；稳定币→"安全支付由 NOWPayments 提供 · 技术支持 Jirvs"。
- 桌面 1280×800 / 手机 390×844 双 tab 一屏装下（无滚动）；稳定币 tab 币种/网络桌面端并排、手机端上下排。
- Antom 直连信息占位接口：`POST /api/v1/merchants/:id/antom/bind`，始终 `live:false`（待真实联调）。

---

# v17 API 变更契约（给前端 B / 测试 C）

版本：0.17.0。最大变更：**Stripe 整体移除**。Payoneer 只负责银行卡，Triple-A 只负责稳定币。
顾客永远不选机构——只选支付方式，机构由 Jirvs 聚合路由自动决定。

## 1. rail 取值（旧 'usdc' 全改掉）

- rail 只接受两个值：`'card'`（银行卡 → Payoneer）、`'stablecoin'`（稳定币 → Triple-A）。
- 旧的 `'usdc'` 已全部替换，传 `usdc` 会 400（`rail 仅支持 card / stablecoin`）。
- `ROUTE_PRIORITY = { card: ['payoneer'], stablecoin: ['triplea'] }`（src/server.js:30）。
- `availableRails(merchant_id)`（src/server.js:42）：payoneer 就绪 → `'card'`；triplea 就绪 → `'stablecoin'`。
  商户入驻即同时开通双通道（见 §5），双开户完成后 `rail_options = ['card','stablecoin']`。
- `provider` 参数已废弃并移除：`POST /api/v1/checkout/sessions` 传 provider 直接 400；
  `POST /api/v1/payments` 改传 `rail`（默认 `'card'`）。

## 2. 新增接口（两个）

### 2.1 GET /api/v1/stablecoins/options（公开，无需鉴权）
返回：
```json
{ "tokens": [
  { "token": "USDT", "networks": ["Tron","Ethereum","Polygon","Arbitrum","Solana"], "default_network": "Tron" },
  { "token": "USDC", "networks": ["Solana","Ethereum","Polygon","Arbitrum"], "default_network": "Solana" }
] }
```
内容与 `src/tripleaAdapter.js` 的 `supportedTokens()` 完全一致（src/tripleaAdapter.js:45）。

### 2.2 POST /api/v1/checkout/sessions/:id/stablecoin/deposit
收银台里用户选定币种与网络后调用。body：`{ "token": "USDT", "network": "Tron" }`
（大小写不敏感，后端 normalize 为 canonical 形式）。
返回：
```json
{ "token": "USDT", "network": "Tron", "address": "TMeEqBrbLsi34ECZzhWBnDLgb3bHEdqM2M",
  "qr_text": "TMeEqBrbLsi34ECZzhWBnDLgb3bHEdqM2M",
  "amount": 50, "currency": "usd" }
```
- `qr_text` 就是 address 字符串——**二维码由前端本地生成**（后端不再生成二维码）。
- 同时把 `token` / `network` / `deposit_address` 写到 session 上，把 `token` / `network` 写到 order 上。
- 错误 400：非法币种/网络组合（`不支持的币种/网络组合`）；该商户未开通稳定币；
  会话不存在 → 404。
- 沙盒演示地址：8 个 币种×网络 组合各一个**固定**地址（写死在 `src/tripleaAdapter.js` 的
  `DEMO_ADDRESSES`，模拟数据非真实收款地址）：
  - USDT/Tron → `TMeEqBrbLsi34ECZzhWBnDLgb3bHEdqM2M`（T 开头 34 位 base58）
  - USDT/Ethereum → `0xd0136f91091fef162dc2077400e952348ed7886f`
  - USDT/Polygon → `0x3401d1e6ac36504e61b37a3a1bb7ecbae8284c0c`
  - USDT/Arbitrum → `0x1773433e116d0e0cc54048f436ae64422fe441a2`
  - USDT/Solana → `Nyp1yfMn9pjyBudMQztVDtFeWP93juQNXmCAZT8mLVAy`（44 位 base58）
  - USDC/Solana → `Dy6jE5uCmZPDHgsUiJNR6TFSkk3sBoV3TVCnBicV1gsD`
  - USDC/Ethereum → `0xff19049865af132e3b4382acb5b4fa2c8d1137a4`
  - USDC/Polygon → `0x29db8af4eb8e282cb042956e2ad2174d1f62355f`
  - USDC/Arbitrum → `0xec1876a05e0586bc2e2b02606f62ec35ad4f4a4a`
- 约 3 秒自动确认由收银台前端做（选稳定币 tab 后 3 秒调 simulate-success）；
  后端要求：`POST /api/v1/checkout/sessions/:id/simulate-success` 传 `rail=stablecoin` 时，
  若会话没有 token/network（即没调过 deposit）直接 400。

## 3. session 新增字段（POST /api/v1/checkout/sessions 返回）

| 字段 | 说明 |
|---|---|
| `rail_options` | `['card']` / `['stablecoin']` / `['card','stablecoin']`（商户开通情况决定 tab） |
| `rail` | 用户实际选定的支付方式（card/stablecoin），收银台回传后写入 |
| `routed` | `true`（Jirvs 聚合路由） |
| `routed_provider` | 实际路由到的机构（payoneer/triplea），模拟成功后写入 |
| `token` / `network` | 稳定币币种/网络，deposit 接口写入 |
| `deposit_address` | 稳定币收款地址，deposit 接口写入 |
| `gateway` | `'jirvs'`（聚合会话） |

`GET /api/v1/checkout/sessions/:id` 原样返回上述字段。

## 4. order 新增字段（GET /api/v1/orders[/:id]）

- 新增：`token`、`network`（稳定币才有值）、`triplea_account`、`payoneer_account`
  （记录实际路由到的机构子商户 id，对账用）。
- `rail` 值域：`'card'` / `'stablecoin'`。
- `gateway` 值域：`'payoneer'` / `'triplea'`（聚合会话落账后写入实际机构）。
- 支付方式展示名（后端统一格式，前端直接用）：`platform.railDisplayName`（src/platform.js:104）——
  银行卡 → `"银行卡"`；稳定币 → `"稳定币 (USDT·Tron)"` 格式（有 token/network 才带括号）。

## 5. 商户（入驻/开户，Stripe 已清零）

- `POST /api/v1/merchants`：`providers` 参数取消，入驻**同时开通双通道子商户**。
  返回新增 `triplea` 块（与 `payoneer` 块同形）：
  `{ account_id, onboarding_url, charges_enabled, payouts_enabled, details_submitted }`。
  旧 `stripe` 块、`stripe_account` 相关字段全部删除；商户对象字段改为
  `payoneer` / `triplea`（各含 `account_id`），另有 `payoneer_onboarding` / `triplea_onboarding` 状态字段。
- **大陆主体拒绝保留**：`country` 为 CN/中国/CHN 时入驻直接 400（platform 内硬编码，始终开启，
  另可用 `BLOCKED_MERCHANT_COUNTRIES` 追加名单）。geoFence 中间件保留（`GEO_FENCE_ENABLED=true` 开启）。
- 开户相关路由（Stripe 版全部删除）：
  - `POST /api/v1/merchants/:id/payoneer-account`（保留）、`POST /api/v1/merchants/:id/triplea-account`（新增）
  - `GET /api/v1/merchants/:id/payoneer-onboarding-link`（新增）、`GET /api/v1/merchants/:id/triplea-onboarding-link`（新增）
  - 旧 `/stripe-account`、`/onboarding-link`（stripe）已删。
- 沙盒模拟开户页：
  - `/sandbox-onboarding-payoneer/:id`（保留）、`/sandbox-onboarding-triplea/:id`（新增），
    各自 `/complete` 提交后标记 KYB 完成并 302 跳回 portal。
  - 旧 `/sandbox-onboarding/:id`（stripe）已删。

## 6. webhook 路径

- `POST /webhooks/payoneer`（保留）、`POST /webhooks/triplea`（新增）。
- `POST /webhooks/stripe` 已删。

## 7. 收银台模板（server.js 服务端渲染）

- 位置：`src/server.js` 的 `renderSandboxCheckout(s, provider)`（约 src/server.js:783 起）。
  注意前端代理 B 将重写本模板；后端只做了 v17 最小改动（删 Stripe、rail 改为 card/stablecoin），
  **模板拿到的数据结构不变**。
- 模板拿到的 `s`（session）字段：`session_id, checkout_url, order_id, merchant_id, amount,
  currency, description, status, payment_id, rail_options, rail, token, network,
  deposit_token, deposit_address, routed, routed_provider, gateway, mode, success_url,
  cancel_url, platform_fee, created_at`。
- tab 按 `s.rail_options` 渲染：`'card'` → 银行卡 tab；`'stablecoin'` → 稳定币 tab
  （DOM id：`tabCard`/`paneCard`、`tabStable`/`paneStable`）。
- 稳定币 pane 显示 `s.deposit_address`（deposit 接口写入后才有值，否则显示占位提示）；
  二维码由前端用 deposit 返回的 `qr_text` 本地生成；约 3 秒自动确认逻辑在模板 JS 里
  （`setTimeout(() => doPay('stablecoin'), 3000)`），B 重写时保留该行为。
- 页脚：聚合会话显示 `安全支付由 Payoneer / Triple-A 提供 · 技术支持 Jirvs`。

## 8. success 跳转参数

收银台支付成功后跳转：`/success.html?session_id=...&payment_id=...&rail=...&method=...&return_url=...`
- `rail=stablecoin` 时额外带上 `&token=USDT&network=Tron`。
- `method` 为支付方式展示名：`银行卡` / `稳定币 (USDT·Tron)`（与 §4 同格式，后端已算好，前端直接显示）。
- 注意：旧 `provider` 参数已去掉（顾客界面不出现机构名）。

## 9. 删掉的东西（前端/测试注意）

- `src/stripeAdapter.js` 已删；`provider=stripe`、`pay_method` 参数已废弃；
  `POST /api/v1/checkout/sessions` 传 provider → 400。
- 旧式显式 provider 会话分支（API 演示页用的）已移除，只走聚合路由。
- `GET /api/v1/funds/overview`：真实模式不再叠加 Stripe 余额（机构余额接口待联调），
  沙盒按内部订单汇总不变，note 文案已更新。
- `GET /api/v1/health`：`gateways` 改为 `{ payoneer: {...}, triplea: {...} }`，顶层 `gateway: 'stripe'` 已删。

## 10. 环境变量（.env.example）

- 删除 `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`。
- 新增 `TRIPLEA_CLIENT_ID` / `TRIPLEA_CLIENT_SECRET`（留空走沙盒模拟；真实凭证需商务获批）。
- `SANDBOX_MODE`、`PAYONEER_*` 不变。

---

# v18 变更记录（版本 0.18.0，2026-09-29）

最大变更：**Triple-A 整体移除**，稳定币通道改走 **NOWPayments 真实接口**。
NOWPayments 官方已无沙盒环境（2026-09-29 官方支持工单确认），测试走正式环境
最小金额真测；自动化测试用 `NOWPAYMENTS_MOCK=true` 内存模拟。

## 1. 移除

- `src/tripleaAdapter.js` 删除；`test/run-v17.js` 删除（被 `test/run-v18.js` 取代）。
- `POST /webhooks/triplea` 已删；`POST /api/v1/merchants/:id/triplea-account`、
  `GET /api/v1/merchants/:id/triplea-onboarding-link` 已删；
  `/sandbox-onboarding-triplea/:id` 模拟开户页已删。
- `.env.example` 删除 `TRIPLEA_CLIENT_ID` / `TRIPLEA_CLIENT_SECRET`。
- 稳定币"约 3 秒自动确认"模拟逻辑删除。

## 2. rail 与路由

- `rail` 值域不变：`'card'`（银行卡 → Payoneer）、`'stablecoin'`（稳定币 → NOWPayments）。
- `ROUTE_PRIORITY = { card: ['payoneer'], stablecoin: ['nowpayments'] }`。
- `availableRails(merchant_id)`：Payoneer `charges_enabled` → `'card'`；
  NOWPayments `bound` → `'stablecoin'`。

## 3. NOWPayments 商户自助绑定（新增）

- `POST /api/v1/merchants/:id/nowpayments/bind`：`{api_key, ipn_secret}`。
  绑定时调 NOWPayments 只读接口校验 Key 有效性；密钥用 AES-256-GCM 加密存储
  （`CRED_ENC_KEY` 环境变量），对外接口永不返回明文或密文。
- `DELETE /api/v1/merchants/:id/nowpayments`：解绑。
- `GET /api/v1/merchants/:id` 返回的 `nowpayments` 块只含 `{ bound, charges_enabled,
  verified_at, coins }` 等状态字段。
- 建单/验签使用各商户自己绑定的密钥（按商户实例化适配器，绑定变更时清缓存）。

## 4. 稳定币真实流程（新增/变更）

- `POST /api/v1/checkout/sessions/:id/stablecoin/deposit`：用商户绑定密钥调
  NOWPayments `POST /payment`（带 `ipn_callback_url`），返回真实 `address`、
  `pay_amount`（应付币数）、`pay_currency`（如 `usdttrc20`）、`payment_id`
  （NOWPayments 单号）。非法币种×网络 400；NOWPayments 报错（如低于最小金额）原文透出。
- `GET /api/v1/checkout/sessions/:id/stablecoin/status`：主动查单
  （`GET /payment/:id`），IPN 未到/延迟时的兜底；服务端另有每 60 秒轮询兜底。
- `POST /webhooks/nowpayments/:merchant_id`：IPN 接收端。验签按官方规范：
  回调对象顶层字段按字母排序后 `JSON.stringify`，IPN Secret 做 HMAC-SHA512，
  与 `x-nowpayments-sig` 比对（常量时间比较）；验签失败 400；重复推送按
  `payment_id:payment_status` 幂等去重。
- 状态映射：`waiting/confirming/confirmed/sending → pending`；
  `finished → succeeded`；`partially_paid` 单独终态（少付，不算成功）；
  `failed/refunded/expired` 对应终态。
- `POST .../simulate-success` 传 `rail=stablecoin` 直接 400（真实链上支付不支持模拟）；
  `POST /api/v1/payments/:id/cancel` 对 NOWPayments 单 400（不支持取消）；
  `POST /api/v1/refunds` 对 NOWPayments 单 400（无退款 API，人工处理）。

## 5. 订单字段（新增）

- `nowpayments_payment_id`（NOWPayments 支付单号）、`pay_amount`（应付币数）、
  `pay_currency`（NOWPayments 币种代码）、`deposit_address`。
- `GET /api/v1/orders/:id` 可查到以上字段；订单 `payment_id` 保持为 Jirvs 内部单号。

## 6. 收银台

- 消费者地址改为 `/checkout/:id`（**浅色主题**，NOWPayments 式布局：步骤条→选币种→
  扫码→等待到账）；`/sandbox-checkout/:id` 仅 302 跳转到新地址。
- 页面不出现沙盒/测试/演示字样与任何技术信息（会话 ID、支付 ID 等）。
- 页脚：聚合会话显示 `安全支付由 Payoneer / NOWPayments 提供 · 技术支持 Jirvs`
  （单通道会话显示对应机构）。

## 7. health 与环境变量

- `GET /api/v1/health`：`channels` 改为 `{ payoneer: {mode}, nowpayments: {mode} }`
  （nowpayments 的 mode 为 `live` 或 `mock`）。
- `.env.example` 新增 `NOWPAYMENTS_MOCK`（测试用内存模拟）、`CRED_ENC_KEY`
  （凭证加密密钥，正式运行必须配置长期固定值）；`BASE_URL` 注释强调 IPN 需公网 HTTPS。

---

# v19 变更记录（版本 0.19.0，2026-09-29）

热修复（v18 当日）：修复稳定币收银台**选不了币种**的问题。

- 之前：点进稳定币 tab 后页面自动用默认 USDT/Tron 建单，建单成功后把币种/网络
  选择器整个藏起来（`setStep2()` 里 `pickBox.style.display='none'`），用户无法切换。
- 现在：币种（USDT/USDC）按钮与网络下拉框**全程可见**，随时可切换；选择器下方增加
  提示"切换币种或网络会自动重新生成收款地址"。
- 切换防抖：币种/网络变化后停手 800ms 才真正建单（`scheduleDeposit()`），避免连续
  点击产生一堆 NOWPayments 支付单；建单加序号守卫，只渲染最后一次请求的结果，
  旧请求回来直接丢弃。

---

# v20 变更记录（版本 0.20.0，2026-09-29）

本版是产品方向转折点：**不再做演示，一切按真实来**。

## 1. 账号体系 + SQLite 持久化

- 新增账号接口：`POST /api/v1/auth/register`（邮箱+密码，密码 scrypt 哈希）、
  `POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me`。
- 登录会话用 `jirvs_session` HttpOnly Cookie（SameSite=Lax，7 天有效期）。
- 数据层从内存 Map 迁移到 SQLite（`src/db.js`，`node:sqlite`，默认 `data/jirvs.db`，
  可用 `DB_PATH` 覆盖）。表：`users` / `sessions` / `merchants` / `orders` / `refunds`。
  重启不丢数据。
- 商户、订单、资金、凭证绑定全部按登录账号隔离：只能看到自己名下的东西。

## 2. API 鉴权收紧

- `POST /api/v1/payments`、`POST /api/v1/checkout/sessions`、
  `POST /api/v1/payments/:id/cancel`、`POST /api/v1/refunds` 现在**要求 API Key**
 （`x-api-key` 头或 body 的 `api_key` 字段）。
- `POST /api/v1/merchants` 要求登录，`GET /api/v1/merchants` 只返回当前账号名下商户。
- API Key 原值**只在创建成功时显示一次**，服务端只存 SHA-256 哈希。
- 商户 Key 前缀改为 `jk_live_`。

## 3. 注册第一步选通道

- `POST /api/v1/merchants` 新增 body 字段 `channels`（数组，`fiat` / `stablecoin` 可多选），
  默认 `['fiat']`。
- 法币通道：大陆主体、香港主体均可注册。**旧的"拒绝大陆主体"规则已作废。**
- 稳定币通道：个人 + 邮箱即可注册；绑定 NOWPayments 密钥前需勾选确认
  "收款由 NOWPayments 提供，Jirvs 只是技术集成"；受限地区只提示不拦截。

## 4. Antom 占位（真实联调前）

- 新增 `POST /api/v1/merchants/:id/antom/bind`（保存 client_id + 商户号，登录后可用）、
  `GET /api/v1/merchants/:id/antom`（只返回是否已绑定，不回显敏感信息）。
- `live: false`：**只是直连信息占位，不代表 Antom 真实联调完成**，联调等国庆后与 Lily 沟通。

## 5. 公开演示页下线

- `/` 跳转到商户门户；`/pay.html` 与 `/dev/pay.html` 要求登录（未登录 302 跳转门户）。
- `GET /api/v1/events`（原公开调试日志）要求登录。
- 开发者区移入商户门户登录后：接口调试台 + 收银台测试入口。

## 6. 收银台（消费者端）

- "取消并返回"改成看得出是按钮的边框样式；收银台品牌色换成 Jirvs 品牌色
  （主色青绿 #3d8b85、点缀金 #c48a3a、文字深藏青 #0e1420）；页面一屏装下（手机+电脑）。
- 聚合会话页脚文案随当前 tab 实时切换：银行卡 tab 显示
  `安全支付由 Payoneer 提供 · 技术支持 Jirvs`，稳定币 tab 显示
  `安全支付由 NOWPayments 提供 · 技术支持 Jirvs`。**不再出现两家一起列**。

---

# v21.6 API 变更契约（给前端 B / 测试 C）

版本：0.21.6。最大变更：**总后台后端（/api/admin/*）+ 注册即发 Key（废除零 active 限制）+ 冻结/解冻商户**。

## 0. 删了什么、为什么

- `createMerchant` 的 `deferKey` 逻辑：注册成功立即自动生成一把 `jk_live_` Key 并返回（仅一次），不再等通道变绿。
- `issueMerchantKey`（首绿才发 Key）：废除；NOWPayments 绑定成功不再返回 Key。
- `rotateMerchantKey` 的"零 active 拒绝"：废除；轮换随时可做。
- portal.html 文案同步："通道开通时仅显示一次"→"注册成功时仅显示一次"；向导第 2 步（拿 Key）直接展示注册返回的 Key；开发者区"重新生成 Key"按钮不再按通道状态禁用。
- 总后台"新增对账记录"：海宝确认没用，正式版不做；只保留数据导出能力（订单/分润接口即数据源）。

## 1. 总后台管理员账号（独立体系）

- 新表：`admins`（id/email 唯一/password_hash/role/superadmin|readonly)、`admin_sessions`、`admin_setup_tokens`、`admin_logs`。
- 会话 Cookie 名：`jirvs_admin`（与商户 `jirvs_session` 完全隔离，互不通用）。
- 密码哈希：scrypt（与 users 表同方案，零第三方依赖；需求写 bcrypt，实现用 scrypt，已知偏差）。
- 首个超级管理员：启动时若 `admins` 为空且设置了 `ADMIN_EMAIL` + `ADMIN_PASSWORD` 环境变量则自动创建（见 .env.example）。
- `POST /api/admin/login` / `POST /api/admin/logout` / `GET /api/admin/me`。
- `POST /api/admin/admins` body: `{ email, role }`（超管专属；不发真邮件，返回一次性 `setup_token` 由超管转交）。
- `POST /api/admin/setup` body: `{ token, password }`（公开；token 24 小时有效、一次有效）。
- 只读管理员：所有 GET 可调；任何写操作（冻结/解冻/添加管理员）返回 403。

## 2. 冻结 / 解冻（超管专属）

- `POST /api/admin/merchants/:id/freeze` body: `{ reason }` 必填，无 reason → 400。
- `POST /api/admin/merchants/:id/unfreeze`。
- 冻结效果：商户登录门户被拒（403）、其 `jk_live_` Key 全部失效（401）、当前登录会话被踢；不碰 Antom/NOWPayments。
- 每次冻结/解冻写入 `admin_logs`（admin_email/action/target/reason/created_at）。

## 3. 总后台数据接口（需管理员登录）

- `GET /api/admin/overview` → `{ merchant_total, fiat_active, fiat_inactive, stable_active, stable_inactive, frozen_count, today_volume_fiat, today_volume_stable }`
- `GET /api/admin/merchants?status=active|frozen&channel=fiat|stablecoin`
- `GET /api/admin/orders?q=名称/邮箱&range=today|7d|30d|custom&start=&end=&status=`（关联 merchants 表搜索）
- `GET /api/admin/profit?period=day|month|all` → `{ antom_fiat: { volume, commission }, nowpayments_stable: { volume, commission } }`；分润口径=成功订单 platform_fee 汇总（真实数据；机构返佣费率待商务落地后接入配置）
- `GET /api/admin/logs?limit=`、`GET /api/admin/admins`

## 4. 测试

- `npm test` → test/run-v22.js，53 项：注册即发 Key、断点续传不重发、零 active 可轮换、绑定不再发 Key、管理员登录/隔离/只读 403、冻结/解冻全链路、总览/商户/订单/分润/日志接口、回归。
