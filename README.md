# Jirvs 聚合收款服务（v20）

对标 Jirvs「聚合收款基础设施」思路的可用版本：**统一支付 API + 双通道适配器 + Webhook 事件推送 + 托管收银台**。
双通道：**Payoneer（银行卡）** + **NOWPayments（稳定币）**。顾客永远只选支付方式，不选机构——
走哪家由 Jirvs 聚合路由按规则自动决定。

架构原则：**Jirvs 只做软件集成，不经手资金、不做合规。** 资金流转、KYC/AML、企业验证
全部由机构（Payoneer / NOWPayments）与商户自有账号承担。NOWPayments 为非托管模式：
商户在 NOWPayments 后台配置自己的收款钱包，具体结算设置以 NOWPayments 后台为准；
对外不得宣称其"持牌"。

v20 关键变化（相对 v18/v19）：

- **账号体系**：商户门户邮箱+密码注册登录（scrypt 哈希，`jirvs_session` Cookie 7 天，生产 HTTPS 自动加 Secure）；
  数据进 SQLite 持久化（`data/jirvs.db`），重启不丢。
- **入驻第一步选通道**：`fiat`（法币/银行卡）/ `stablecoin`（稳定币）可多选；法币通道大陆+香港主体均可注册
  （老"拒绝大陆主体"规则作废）；稳定币通道明示第三方收款流程（去 NOWPayments 拿 Key → 回 Jirvs 绑定 → 提币在 NOWPayments）。
- **API Key 只显示一次**：服务端只存 SHA-256 哈希；丢了可在门户"重新生成 API Key"（旧 Key 立即失效）。
- **收银台按真实产品重做**：Jirvs 品牌色、真按钮"取消并返回"、页脚随 tab 显示对应机构、桌面+手机一屏装下。
- **公开演示页下掉**：`/pay.html` 与 API 演示页改为登录后可见（开发者区接口调试台）；`/` 跳转商户门户。
- **Antom 占位**：直连信息接口 `live:false`，文案一律"待确认/待真实联调"，不做上线承诺。

## 快速开始

```bash
cd stripe-payments
npm install
cp .env.example .env   # 默认 SANDBOX_MODE=true（银行卡沙盒模拟）
npm start
```

浏览器打开 http://localhost:3000 ，会跳转到商户门户。给海宝准备的两个入口：

| 页面 | 地址 | 用来干嘛 |
|---|---|---|
| 商户门户 | http://localhost:3000/portal.html | 注册登录、商户入驻（第一步选通道）、通道开通（Payoneer 开户卡 + NOWPayments 绑定卡）、看订单、看资金、重新生成 API Key |
| 开发者区（登录后） | 门户内"开发者"页 | 接口调试台（原公开 API 演示页，已下掉）+ 收银台测试入口（原 /pay.html，登录后可见） |

## 架构：聚合路由

```
用户选支付方式（rail）──→ Jirvs 聚合路由 ──→ 机构适配器 ──→ 机构
   card=银行卡        ROUTE_PRIORITY      payoneerAdapter → Payoneer（沙盒模拟；战略上待 Antom 接入后替换）
   stablecoin=稳定币                          nowpaymentsAdapter → NOWPayments（真实接口；用商户绑定的密钥）
```

- `rail` 只有两个值：`card`（银行卡 → Payoneer）、`stablecoin`（稳定币 → NOWPayments）。
- 收银台的 tab 按商户**已开通**的通道渲染：只开银行卡 → 只有银行卡；
  只开稳定币 → 只有稳定币；双开 → 两个都有。没开通的支付方式根本不会出现。
- **稳定币不支持模拟成功**：真实链上支付，只能等 NOWPayments IPN 回调到账或 Jirvs 轮询确认。

## 统一 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/health` | 健康检查：`channels: { payoneer: {mode}, nowpayments: {mode} }` |
| POST | `/api/v1/payments` | 创建支付：`{merchant_id, order_id, amount, currency, rail?, description?, webhook_url?, platform_fee?}`，`rail` 默认 `card`；稳定币须同时传 `token`（USDT/USDC）与 `network`（网络） |
| GET | `/api/v1/payments/:id` | 查询支付状态 |
| POST | `/api/v1/payments/:id/cancel` | 取消支付（NOWPayments 链上支付不支持取消，直接 400） |
| POST | `/api/v1/refunds` | 退款：`{payment_id, amount?, currency?}`（NOWPayments 不支持退款 API，直接 400，人工处理） |
| POST | `/api/v1/payments/:id/simulate-success` | 仅沙盒：模拟支付成功并触发事件 |
| POST | `/api/v1/checkout/sessions` | 创建托管收银台（聚合路由）：`{merchant_id, order_id, amount, currency, description?, success_url?, cancel_url?, webhook_url?, platform_fee?}`，返回 `checkout_url`（`/checkout/:id`，不含 sandbox 字样）+ `rail_options`；**传 `provider` 直接 400** |
| GET | `/api/v1/checkout/sessions/:id` | 查询收银台会话状态（含 `rail_options` / `rail` / `token` / `network` / `deposit_address`） |
| POST | `/api/v1/checkout/sessions/:id/simulate-success` | 仅沙盒：模拟收银台支付成功，`{rail: 'card' \| 'stablecoin'}`；**稳定币直接 400（不支持模拟）** |
| GET | `/api/v1/stablecoins/options` | 公开：稳定币 × 网络 × 默认网络（USDT 5 网默认 Tron；USDC 4 网默认 Solana） |
| POST | `/api/v1/checkout/sessions/:id/stablecoin/deposit` | 选定币种与网络后调用：`{token, network}` → 返回真实收款 `address`（`qr_text` 即该地址，前端本地生成二维码）+ `pay_amount`（应付币数），同时写入会话与订单 |
| GET | `/api/v1/checkout/sessions/:id/stablecoin/status` | 稳定币主动查单（IPN 未到/延迟时的兜底；前端每 20 秒调一次） |
| POST | `/api/v1/merchants` | 商家入驻：`{company*, country, contact, email*, business_type, volume}`，自动开通 Payoneer 子商户；**稳定币需商户自助绑定**，返回 `merchant_id` + `api_key`（仅返回一次） |
| GET | `/api/v1/merchants` | 商户列表（不返回 API key 与任何凭证） |
| GET | `/api/v1/merchants/:id` | 查询商户：`payoneer` 开户块 + `nowpayments` 绑定状态（不返回 API key 与任何凭证） |
| POST | `/api/v1/merchants/:id/nowpayments/bind` | 绑定商户自有 NOWPayments 账号：`{api_key, ipn_secret}`；绑定时用只读接口校验 Key 有效性，密钥 AES-256-GCM 加密存储 |
| DELETE | `/api/v1/merchants/:id/nowpayments` | 解绑 NOWPayments（已建的支付单不受影响） |
| POST | `/api/v1/merchants/:id/payoneer-account` | （重新）创建 Payoneer 子商户 + 开户链接 |
| GET | `/api/v1/merchants/:id/payoneer-onboarding-link` | 刷新 Payoneer 开户链接 |
| GET | `/api/v1/orders` | 内部订单列表：`?merchant_id=&status=&limit=` |
| GET | `/api/v1/orders/:id` | 内部订单详情（含 `rail` / `gateway` / `token` / `network` / `deposit_address` / `nowpayments_payment_id`） |
| GET | `/api/v1/funds/overview` | 资金视图（只读）：按内部订单汇总；Jirvs 不经手资金 |
| GET | `/api/v1/events` | 事件日志（演示页轮询） |
| POST | `/webhooks/payoneer` | Payoneer Webhook 接收端（需 raw body，已内置） |
| POST | `/webhooks/nowpayments/:merchant_id` | NOWPayments IPN 接收端：`x-nowpayments-sig` 验签（HMAC-SHA512，官方规范），重复推送幂等去重 |

平台统一事件：`payment.created` / `payment.succeeded` / `payment.partially_paid` /
`payment.failed` / `payment.expired` / `payment.canceled` /
`refund.succeeded` / `checkout.session.created`。
创建支付/收银台时传入 `webhook_url`，事件会实时 POST 转发到该地址。

支付方式展示名（后端统一算好，前端直接显示）：银行卡 → `银行卡`；
稳定币 → `稳定币 (USDT·Tron)` 格式。

## 稳定币收款（NOWPayments：USDT / USDC）

1. 商户先在 NOWPayments 官网注册商户账号、配置自己的收款钱包，然后在**商户门户**的
   NOWPayments 绑定卡填 API Key + IPN Secret。绑定时 Jirvs 用只读接口校验 Key，
   密钥加密存储，门户永远不再显示完整值。
2. 收银台里用户先选**币种**（USDT / USDC），再选**网络**
   （USDT：Tron / Ethereum / Polygon / Arbitrum / Solana，默认 Tron；
   USDC：Solana / Ethereum / Polygon / Arbitrum，默认 Solana）。
3. 前端调 `POST /api/v1/checkout/sessions/:id/stablecoin/deposit`，
   Jirvs 用**该商户绑定的密钥**向 NOWPayments 创建真实收款单，返回真实收款地址与应付币数；
   `qr_text` 就是地址字符串，**二维码由前端本地生成**（`public/qrcode.js`，无外部请求）。
4. 用户用钱包 App 扫码转账。页面显示"等待到账…"并自动轮询：
   - NOWPayments IPN 回调到 `/webhooks/nowpayments/:merchant_id`（需公网可达），验签通过后订单记成功；
   - 前端每 20 秒调 `stablecoin/status` 主动查单，服务端另有每 60 秒兜底轮询（IPN 丢失时自动捞回）。
5. **少付（partially_paid）不算成功**：页面提示已收金额与应付金额，请联系商户处理补付；
   过期/失败明确提示重新下单。
6. 每个币种 × 网络组合的收款地址都不同（Tron 地址 T 开头、Ethereum 系 0x 开头、
   Solana 44 位 base58），绝不会一个地址冒充所有网络。

**测试说明**：NOWPayments 官方已不再提供沙盒环境（2026-09 官方支持确认），
真实测试只能走正式环境最小金额真测。单元测试与联调请用 `NOWPAYMENTS_MOCK=true`
（内存模拟，不联网、不花钱）：`npm test`。

成功页回跳参数：`/success.html?session_id=…&payment_id=…&rail=…&method=…&return_url=…`，
稳定币时额外带 `&token=USDT&network=Tron`；`method` 为展示名（`银行卡` / `稳定币 (USDT·Tron)`）。

## 收银台与成功页（顾客真实界面）

- `/checkout/:id` —— 托管收银台（浅色主题，NOWPayments 式布局：步骤条→选币种→扫码→等待到账）。
  只显示：商户名称、金额、订单（只读）、支付方式 tab、付款按钮。
  银行卡 tab 显示 Visa / Mastercard 品牌（卡号输入自动识别品牌）；
  页脚一句话：`安全支付由 Payoneer / NOWPayments 提供 · 技术支持 Jirvs`。
  **页面不出现沙盒/测试/演示字样与任何技术信息。**
  旧地址 `/sandbox-checkout/:id` 仅 302 跳转到新地址。
- `/success.html` —— 支付成功页：订单号、商户名称、支付方式；**返回商家**按钮 + 3 秒倒计时自动返回。
- `/pay.html` —— 收银台测试入口（测试工具，顾客看不到）：一个按钮模拟顾客点「去结算」。

## 商户入驻与开户（双通道）

1. `POST /api/v1/merchants` 注册（5 个字段），自动创建 Payoneer 子商户，
   返回 `account_id` + `onboarding_url`；稳定币通道初始未绑定。
2. 银行卡：商户点开户链接，在 Payoneer 托管页面完成企业验证（KYB 由机构直接收集，
   Jirvs 不存储）；沙盒用 `/sandbox-onboarding-payoneer/:id` 模拟。
3. 稳定币：商户自有 NOWPayments 账号，在商户门户 NOWPayments 绑定卡绑定
   API Key + IPN Secret；`GET /api/v1/merchants/:id` 查 `nowpayments.bound`。
4. 收款硬规则：商户不存在 → 400；对应通道未完成开户/绑定 → 400 直接拒绝（不许兜底）。

## 环境变量（.env.example）

```
SANDBOX_MODE=true            # 沙盒模拟（银行卡）；false=真实模式（需凭证+联调）
NOWPAYMENTS_MOCK=            # =true 时 NOWPayments 走内存模拟（测试用，不联网）
CRED_ENC_KEY=                # 商户 NOWPayments 密钥加密密钥（64 位十六进制），正式运行必须配置长期固定值
PAYONEER_MERCHANT_CODE=       # Payoneer 真实凭证（合作伙伴审批后获取），留空走沙盒
PAYONEER_PAYMENT_TOKEN=
PAYONEER_DIVISION=
GEO_FENCE_ENABLED=false      # IP 地理围栏，生产开启
GEO_BLOCKED_COUNTRIES=CN
BASE_URL=                    # 公网地址；NOWPayments IPN 必须能公网访问到本服务
```

## 合规控制

1. **大陆主体入驻直接拒绝**：`country` 为 CN / 中国 / CHN 时注册返回 400，
   硬编码在平台层，始终开启，不可配置关闭。另可用 `BLOCKED_MERCHANT_COUNTRIES` 追加名单。
2. **IP 地理围栏**（`src/geoFence.js`）：`GEO_FENCE_ENABLED=true` 开启后，
   受限地区 IP 发起支付/建收银台直接 403。生产还需在 Cloudflare 开 WAF 地理拦截做边缘防御。
3. 上线真钱前必须找律师做合规审查。

## v18 变更说明（Triple-A 已整体移除，稳定币改走 NOWPayments）

- 删除 `src/tripleaAdapter.js`；稳定币通道由模拟的 Triple-A 改为 **NOWPayments 真实接口直调**
  （`src/nowpaymentsAdapter.js`）：建单用商户自有 Key，返回真实收款地址与应付币数；
  到账确认靠 NOWPayments IPN（`x-nowpayments-sig` 验签，官方 HMAC-SHA512 规范）+ 主动轮询兜底。
- 商户入驻不再代开稳定币子商户：稳定币通道改为商户在**商户门户自助绑定**
  （`POST /api/v1/merchants/:id/nowpayments/bind`），密钥 AES-256-GCM 加密存储，
  对外接口永不返回明文凭证。
- 收银台消费者地址改为 `/checkout/:id`（浅色主题，NOWPayments 式布局）；
  `/sandbox-checkout/:id` 仅做 302 跳转。
- `rail` 值域不变：`card`（银行卡 → Payoneer）、`stablecoin`（稳定币 → NOWPayments）；
  `ROUTE_PRIORITY = { card: ['payoneer'], stablecoin: ['nowpayments'] }`。
- 稳定币**不支持模拟成功**、不支持取消、不支持退款 API（链上支付特性），相应接口明确 400。
- 新增订单终态：`partially_paid`（少付，不算成功）、`expired`、`refunded`。
- `GET /api/v1/health` 的 `channels` 改为 `{ payoneer: {mode}, nowpayments: {mode} }`；
  `.env.example` 删除 `TRIPLEA_*`，新增 `NOWPAYMENTS_MOCK` / `CRED_ENC_KEY`。
- 旧测试文件 `test/run-v17.js` 已被 `test/run-v18.js` 取代并删除（72 项）。

## 项目结构

```
stripe-payments/
├── src/
│   ├── server.js            # Express 服务：统一 API 路由 + 托管收银台模板渲染
│   ├── payoneerAdapter.js   # Payoneer 适配器（银行卡，沙盒/真实双模式；战略上待 Antom 替换）
│   ├── nowpaymentsAdapter.js# NOWPayments 适配器（稳定币真实接口：建单/查单/IPN 验签/凭证加密）
│   ├── platform.js          # 商户/订单/资金视图（只读），大陆主体拒绝，支付方式展示名
│   ├── eventBus.js          # 事件总线：事件日志 + 转发到商户 webhook_url
│   └── geoFence.js          # IP 地理围栏中间件
├── public/
│   ├── index.html          # API 演示页（统一接口调试 + 事件流）
│   ├── pay.html            # 收银台测试入口（测试工具）
│   ├── portal.html         # 商户门户（入驻/通道开通/订单/资金）
│   ├── success.html        # 支付成功页
│   └── qrcode.js           # 前端本地二维码生成（无外部请求）
├── test/
│   └── run-v18.js          # 72 项自动化测试（npm test，NOWPAYMENTS_MOCK=true）
├── .env.example
└── package.json
```

## 测试

```bash
npm test
```

72 项全过显示 `ALL PASS`。覆盖：NOWPayments 适配器单元（币种×网络映射、状态映射、
IPN 签名、凭证加密、mock 建单/查单）、商户 NOWPayments 绑定（加密存储、对外不泄露、
解绑）、服务联调（收银台仅稳定币通道、deposit 真实地址、IPN 到账→成功、重复 IPN 幂等、
错误签名 400、少付不算成功、聚合直接支付、取消/退款 400）、Triple-A/Stripe 残留扫描。

真实小额测试（NOWPayments 正式环境）：把服务部署到公网 HTTPS，商户绑定自己的
NOWPayments Key，用接近最小金额的币种真实转一笔，观察 IPN 到账。注意本地
localhost 收不到 NOWPayments 回调。

## 说明

- 本服务只提供软件集成层，不经手资金（与 Jirvs 官网声明的定位一致）。
- 数据存于内存，重启丢失；生产使用请接入数据库并完善幂等与重试。
- Payoneer 真实凭证需经合作伙伴审批获取；NOWPayments 商户自助注册即可获取 API Key。
- 正式运行前：配置长期固定的 `CRED_ENC_KEY`，换掉测试用 Key，用公网 HTTPS 部署。

## 删了什么（v18 精简说明）

- `src/tripleaAdapter.js` 整个删除：Triple-A 合作未落地，其模拟适配器（含固定演示地址表）
  已无存在意义，稳定币通道由 NOWPayments 真实接口替代。
- `test/run-v17.js` 删除：被 `test/run-v18.js`（72 项）取代。
- `.env.example` 的 `TRIPLEA_CLIENT_ID` / `TRIPLEA_CLIENT_SECRET` 删除。
- 收银台深色主题删除：v18 改为浅色主题（海宝明确要求）。
- 商户门户的 Triple-A 开户卡删除：改为 NOWPayments 自助绑定卡。
- 稳定币"约 3 秒自动确认"模拟逻辑删除：真实链上支付只能等到账确认。
