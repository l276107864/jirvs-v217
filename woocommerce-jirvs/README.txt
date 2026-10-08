=== Jirvs 支付网关 ===
Contributors: jirvs
Tags: woocommerce, payment, jirvs, 收款, 支付网关
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

通过 Jirvs 聚合收款：在 WooCommerce 结账页用银行卡 / 本地电子钱包收款，一次接入，多家支付机构智能路由。

== 说明 ==

Jirvs 是支付集成 SaaS。装上这个插件，你的 WooCommerce 商店就能通过 Jirvs 收银台收款：

* 买家在结账页选择"Jirvs 支付"，跳转到 Jirvs 安全收银台付款（银行卡 / 本地电子钱包）
* 付完自动跳回商店，订单自动标为"已付款"
* 你在 Jirvs 商户门户统一看订单、对账，不用一家家机构去对

Jirvs 本身不经手资金，钱从买家直接到支付机构再到你的商户账户。

== 安装 ==

1. 先确认已经安装并启用了 WooCommerce（版本 7.0 以上）。
2. 把 `woocommerce-jirvs` 文件夹上传到 `wp-content/plugins/` 目录（或在"插件 → 安装插件 → 上传插件"里上传 zip 包）。
3. 到"插件"页启用"Jirvs 支付网关"。
4. 到"WooCommerce → 设置 → 收款"，找到"Jirvs 支付"，点"管理"，填入：
   * **Jirvs API Key**：以 `jk_live_` 开头。在 Jirvs 商户门户 → 接入区点"生成 Key"获取（需先订阅 $199 终身，Key 只显示一次，请妥善保存）。
   * **商户 ID**：Jirvs 商户门户里显示的商户 ID（`m_` 开头）。
5. 勾选"启用 Jirvs 支付"，保存。

== 常见问题 ==

= 买家结账时看不到 Jirvs 支付选项？ =

先检查两点：① 插件已启用；② 后台"Jirvs 支付"设置里 API Key 和商户 ID 都填了。有一个没填，结账页会自动隐藏 Jirvs，避免买家点进来报错。

= 提示"API Key 无效"？ =

到 Jirvs 商户门户 → 接入区重新生成一把 Key（旧 Key 会立即作废），复制新的填进来。注意 Key 只显示一次，关掉弹窗就看不到了。

= 支持哪些货币？ =

USD、CNY、HKD、EUR、GBP、JPY、SGD、AUD。商店货币不在此列时，结账页会自动提示买家换支付方式。

= 买家付了钱，订单还是"待付款"？ =

插件在买家跳回来时会向 Jirvs 查询真实状态。如果当时网络抖动没查到，订单会保持"待付款"，Jirvs 的异步通知稍后会补上。你也可以在 Jirvs 商户门户按订单号核对。

= 测试模式有什么用？ =

打开后订单会标记为测试来源，方便联调时区分。正式营业前记得关掉。

== 更新日志 ==

= 1.0.0 =
* 首版：创建支付会话、收银台跳转、回跳验单、后台设置页。
