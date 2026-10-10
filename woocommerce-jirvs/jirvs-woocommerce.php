<?php
/**
 * Plugin Name: Jirvs 支付网关
 * Plugin URI: https://www.jirvs.com
 * Description: 通过 Jirvs 聚合收款：在 WooCommerce 结账页用银行卡 / 本地电子钱包收款，一次接入，多家支付机构智能路由。
 * Version: 1.0.1
 * Author: Jirvs Limited
 * Author URI: https://www.jirvs.com
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: jirvs-woocommerce
 * Domain Path: /languages
 * Requires Plugins: woocommerce
 * WC requires at least: 7.0
 * WC tested up to: 9.0
 *
 * 插件主文件：只负责"启动"——检查 WooCommerce 是否安装，然后加载支付网关类。
 * 真正的收款逻辑都在 includes/class-jirvs-gateway.php 里。
 */

// 安全起见：禁止直接访问本文件
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// 插件版本号（升级时改这里）
define( 'JIRVS_WC_VERSION', '1.0.1' );
// 插件所在目录（用来拼 include 路径）
define( 'JIRVS_WC_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

/**
 * 第一步：等所有插件都加载完再动手。
 * 原因：必须确认 WooCommerce 已经装好，否则没法注册支付网关。
 */
add_action( 'plugins_loaded', 'jirvs_wc_init', 11 );

function jirvs_wc_init() {
    // WooCommerce 没装？在后台顶部给管理员一条红色提示，然后什么都不做。
    if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
        add_action( 'admin_notices', 'jirvs_wc_missing_notice' );
        return;
    }

    // 加载网关类（真正的收款逻辑）
    require_once JIRVS_WC_PLUGIN_DIR . 'includes/class-jirvs-gateway.php';

    // 告诉 WooCommerce："Jirvs" 是一个可用的支付方式
    add_filter( 'woocommerce_payment_gateways', 'jirvs_wc_add_gateway' );
}

/**
 * 把 Jirvs 网关加进 WooCommerce 的支付方式列表
 */
function jirvs_wc_add_gateway( $gateways ) {
    $gateways[] = 'WC_Gateway_Jirvs';
    return $gateways;
}

/**
 * WooCommerce 缺失时的后台提示
 */
function jirvs_wc_missing_notice() {
    echo '<div class="notice notice-error"><p><strong>Jirvs 支付网关</strong>需要先安装并启用 WooCommerce 才能工作。</p></div>';
}

/**
 * 插件被启用时：目前没有什么特殊要做，设置项在网关类里自动注册。
 * （留这个钩子是为了以后升级时做数据迁移）
 */
register_activation_hook( __FILE__, 'jirvs_wc_activate' );
function jirvs_wc_activate() {
    // v1.0.0：无需初始化数据
}
