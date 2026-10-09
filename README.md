# Jirvs 聚合收款服务（法币版）

Jirvs 是面向跨境电商商户的收款集成软件。平台只提供软件集成、统一收银台、订单同步和商户门户，**不经手买家交易资金**；资金由商户在 Stripe Connect 账户直接结算。

## 当前规则

- **仅支持法币收款**；稳定币、虚拟资产和链上收款已下线。
- 法币机构：**Stripe Connect**。商户在 Jirvs 门户跳转 Stripe Hosted Onboarding，完成 KYB 后开通银行卡收款。
- 通道真实联调完成前保持 `pending`，不会伪装成可收款状态。
- 无推荐码：**USD 299 终身**；支付下单时提交有效推荐码或推荐链接中的 `ref`：**USD 199 终身**。不在注册时锁定归因，始终以本次支付时最新提交的推荐码为准。
- 商户注册一次性返回 `jk_live_`（插件/服务端）和 `jk_pub_`（公开 JS）两把 Key；服务端只存哈希，轮换后旧 Key 立即失效。
- 伙伴佣金：V1 30%、V2 50%，按签约版本快照一次性返佣，每月 5 日结算上月佣金。
- 订阅支付先创建 `pending` 记录。支付机构确认后调用 `POST /webhooks/subscriptions/:provider`，携带 HMAC-SHA256 `x-jirvs-signature` 和如下 JSON：`{"event":"payment.succeeded","event_id":"evt_1","subscription_id":"sub_x","payment_id":"pay_x","amount":199,"currency":"USD"}`。服务端会校验金额/币种、幂等处理、激活订阅并只生成一次佣金。

## 本地运行

需要 Node.js 24（项目使用内置 `node:sqlite`）：

```bash
npm ci
npm start
```

打开 `http://localhost:3000/portal.html`。

## 测试

```bash
npm test
```

测试覆盖法币-only门禁、双 Key、订阅报价、pending 订阅、最新推荐码和支付回调幂等激活/计佣。

## 生产前置条件

1. 配置 Stripe Connect 平台密钥和 Webhook，完成真实支付、Webhook 验签、幂等和退款状态同步。
2. 将订阅 pending 接入真实支付回调；只有确认到账后才变为 active 并产生佣金。
3. 在真实 WordPress + WooCommerce 环境完成插件安装、下单、回调和退款测试。
4. 正式环境使用 PostgreSQL 或等价托管数据库，并配置 HTTPS、密钥轮换和审计告警。
