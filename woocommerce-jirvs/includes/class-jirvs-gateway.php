<?php
/**
 * Jirvs 支付网关类
 *
 * 继承 WooCommerce 的 WC_Payment_Gateway，WooCommerce 会自动：
 *  - 在"结账页"显示 Jirvs 支付选项
 *  - 在"WooCommerce → 设置 → 收款"里生成下面的设置表单
 *
 * 工作流程（买家视角）：
 *  1. 买家在结账页选"Jirvs 支付"，点"下单"
 *  2. process_payment() 被调用 → 向 Jirvs API 创建支付会话 → 拿到收银台链接
 *  3. 买家被带到 Jirvs 收银台，用银行卡 / 本地钱包付款
 *  4. 付完跳回商店"订单确认页" → 插件向 Jirvs 查询这笔是否真的付成功了
 *  5. 确认成功 → 订单标为"已付款"，给买家看感谢页
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class WC_Gateway_Jirvs extends WC_Payment_Gateway {

    /** @var string Jirvs API 根地址，如 https://api.jirvs.com（后台可改） */
    private $api_base;
    /** @var string 商户的 jk_live_ 开头 API Key */
    private $api_key;
    /** @var string 商户 ID（商户门户里能看到） */
    private $merchant_id;
    /** @var string yes/no：测试模式开关 */
    private $testmode;

    /**
     * 构造函数：WooCommerce 在每次需要时 new 一个出来。
     * 这里只做"自我介绍"：我是谁、叫什么、有哪些设置项。
     */
    public function __construct() {
        // 网关唯一标识（WooCommerce 内部用，改了会导致旧订单认不出来，所以别改）
        $this->id = 'jirvs';

        // 结账页支付方式列表里显示的图标（没有就留空，用文字）
        $this->icon = '';

        // 是否在后台"收款设置"页显示"启用/禁用"复选框
        $this->has_fields = false;

        // 结账页显示的标题和描述（可在后台设置里改）
        $this->method_title       = 'Jirvs 支付';
        $this->method_description = '通过 Jirvs 聚合收款：银行卡 / 本地电子钱包，一次接入，智能路由。';

        // 先给默认值，下面 load_settings() 会用后台保存的值覆盖
        $this->title       = '银行卡 / 本地钱包（Jirvs 安全支付）';
        $this->description = '跳转到 Jirvs 安全收银台完成付款，支持国际信用卡与本地电子钱包。';

        // ---- 注册后台设置表单（WooCommerce → 设置 → 收款 → Jirvs 支付）----
        $this->init_form_fields();
        // ---- 读取后台保存好的设置 ----
        $this->init_settings();

        // 把设置读进成员变量，方便后面用
        $this->title       = $this->get_option( 'title', $this->title );
        $this->description = $this->get_option( 'description', $this->description );
        $this->api_key     = trim( (string) $this->get_option( 'api_key', '' ) );
        $this->merchant_id = trim( (string) $this->get_option( 'merchant_id', '' ) );
        // 默认正式地址；测试时在后台改成沙盒地址即可，不用改代码
        $this->api_base    = rtrim( trim( (string) $this->get_option( 'api_base', 'https://api.jirvs.com' ) ), '/' );
        $this->testmode    = $this->get_option( 'testmode', 'no' );

        // 后台点了"保存更改"后，WooCommerce 会触发这个钩子，把新设置写进数据库
        add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );

        // 买家从 Jirvs 收银台付完钱跳回来时，走这个地址做"验单"
        // 最终 URL 形如：https://你的商店.com/wc-api/jirvs_return?session_id=cs_xxx&order_id=123
        add_action( 'woocommerce_api_jirvs_return', array( $this, 'handle_return' ) );
    }

    /**
     * 后台设置表单：每个数组项就是一行设置。
     * 商户只需要填"API Key"和"商户 ID"，其他都有合理默认值。
     */
    public function init_form_fields() {
        $this->form_fields = array(
            'enabled' => array(
                'title'   => '启用 / 禁用',
                'type'    => 'checkbox',
                'label'   => '启用 Jirvs 支付',
                'default' => 'yes',
            ),
            'title' => array(
                'title'       => '结账页标题',
                'type'        => 'text',
                'description' => '买家在结账页看到的支付方式名称。',
                'default'     => '银行卡 / 本地钱包（Jirvs 安全支付）',
                'desc_tip'    => true,
            ),
            'description' => array(
                'title'       => '结账页描述',
                'type'        => 'textarea',
                'description' => '买家选中 Jirvs 后看到的一行说明。',
                'default'     => '跳转到 Jirvs 安全收银台完成付款，支持国际信用卡与本地电子钱包。',
                'desc_tip'    => true,
            ),
            'api_key' => array(
                'title'       => 'Jirvs API Key',
                'type'        => 'password',
                'description' => '以 jk_live_ 开头。在 Jirvs 商户门户 → 接入区点"生成 Key"获取（订阅 $199 终身后可生成，只显示一次，请妥善保存）。',
                'default'     => '',
                'desc_tip'    => true,
            ),
            'merchant_id' => array(
                'title'       => '商户 ID',
                'type'        => 'text',
                'description' => 'Jirvs 商户门户里显示的商户 ID（m_ 开头）。API 调用时用来标识是哪个商户。',
                'default'     => '',
                'desc_tip'    => true,
            ),
            'api_base' => array(
                'title'       => 'Jirvs API 地址',
                'type'        => 'text',
                'description' => '正式环境不用改。联调测试时可填沙盒地址。',
                'default'     => 'https://api.jirvs.com',
                'desc_tip'    => true,
            ),
            'testmode' => array(
                'title'       => '测试模式',
                'type'        => 'checkbox',
                'label'       => '启用测试模式（订单金额按测试处理，不产生真实扣款）',
                'description' => '打开后，插件会在 Jirvs 后台把订单标记为测试来源。',
                'default'     => 'no',
                'desc_tip'    => true,
            ),
        );
    }

    /**
     * 检查网关当前能不能用。
     * 场景：API Key 或商户 ID 没填 → 结账页就不显示 Jirvs，避免买家点进来报错。
     */
    public function is_available() {
        if ( 'yes' !== $this->enabled ) {
            return false;
        }
        if ( '' === $this->api_key || '' === $this->merchant_id ) {
            return false; // 关键信息没配齐，先隐藏
        }
        return parent::is_available();
    }

    /**
     * 核心：买家点"下单"后执行。
     *
     * @param int $order_id WooCommerce 订单号
     * @return array WooCommerce 约定格式：array('result' => 'success', 'redirect' => '跳转地址')
     */
    public function process_payment( $order_id ) {
        $order = wc_get_order( $order_id );
        if ( ! $order ) {
            wc_add_notice( '订单不存在，请重新下单。', 'error' );
            return array( 'result' => 'fail' );
        }

        // 金额：WooCommerce 存的是"元"，Jirvs API 要的也是"元"（不是分），直接传
        $amount   = (float) $order->get_total();
        $currency = strtoupper( $order->get_currency() );

        // Jirvs 目前支持的法币（以后加了新币种，后端支持即可，前端不用改）
        $supported = array( 'USD', 'CNY', 'HKD', 'EUR', 'GBP', 'JPY', 'SGD', 'AUD' );
        if ( ! in_array( $currency, $supported, true ) ) {
            wc_add_notice( 'Jirvs 暂不支持 ' . esc_html( $currency ) . ' 结算，请换一种支付方式。', 'error' );
            return array( 'result' => 'fail' );
        }

        // 买家付完钱，Jirvs 要把他送回哪里：WooCommerce 自带的"订单确认页"
        // 我们在后面拼上 session_id 和 order_id，回来时用来验单
        $return_url = add_query_arg(
            array(
                'wc-api'     => 'jirvs_return',
                'order_id'   => $order_id,
                // 下面 session_id 在拿到 Jirvs 返回后再补
            ),
            home_url( '/' )
        );

        // ---- 调用 Jirvs API：创建支付会话 ----
        $api_result = $this->jirvs_api_post(
            '/api/v1/checkout/sessions',
            array(
                'merchant_id' => $this->merchant_id,
                'order_id'    => (string) $order_id,
                'amount'      => $amount,
                'currency'    => strtolower( $currency ),
                'description' => sprintf( '订单 %s - %s', $order->get_order_number(), get_bloginfo( 'name' ) ),
                // 付完回来的地址（带 order_id，session_id 稍后补上）
                'success_url' => $return_url,
                // 买家在收银台点"取消"：回到结账页
                'cancel_url'  => wc_get_checkout_url(),
            )
        );

        // API 调用失败（网络不通、Key 错了、商户没开通通道……）：给买家一句人话
        if ( is_wp_error( $api_result ) ) {
            wc_add_notice( '支付发起失败：' . $api_result->get_error_message() . ' 请稍后重试或联系店主。', 'error' );
            return array( 'result' => 'fail' );
        }

        $session_id   = isset( $api_result['session_id'] ) ? $api_result['session_id'] : '';
        $checkout_url = isset( $api_result['checkout_url'] ) ? $api_result['checkout_url'] : '';
        if ( '' === $session_id || '' === $checkout_url ) {
            wc_add_notice( '支付服务暂时不可用，请稍后重试。', 'error' );
            return array( 'result' => 'fail' );
        }

        // checkout_url 是相对路径（/checkout/cs_xxx），拼成完整 URL
        if ( 0 === strpos( $checkout_url, '/' ) ) {
            $checkout_url = $this->api_base . $checkout_url;
        }

        // 把 Jirvs 会话号记在订单备注里，方便对账时查
        $order->add_order_note( 'Jirvs 支付会话已创建：' . $session_id );
        // 订单先标"待付款"，等买家付完回来再确认
        $order->update_status( 'pending', '等待买家在 Jirvs 收银台完成付款。' );
        // 把会话号存到订单 meta，验单时用
        $order->update_meta_data( '_jirvs_session_id', $session_id );
        $order->save();

        // 告诉 WooCommerce：成功，请把买家带到收银台
        return array(
            'result'   => 'success',
            'redirect' => esc_url_raw( $checkout_url ),
        );
    }

    /**
     * 买家从 Jirvs 收银台回来时走这里（URL：/wc-api/jirvs_return）。
     * 必须再向 Jirvs 查一次这笔到底付成功没有——不能只信 URL 参数，防止伪造。
     */
    public function handle_return() {
        $order_id   = isset( $_GET['order_id'] ) ? absint( $_GET['order_id'] ) : 0;
        $session_id = isset( $_GET['session_id'] ) ? sanitize_text_field( wp_unslash( $_GET['session_id'] ) ) : '';

        $order = wc_get_order( $order_id );
        if ( ! $order ) {
            wp_die( '订单不存在。', 'Jirvs 支付', array( 'response' => 404 ) );
        }

        // 订单已经是"已付款"就不用重复处理（防止买家刷新页面导致重复发货）
        if ( $order->is_paid() ) {
            wp_safe_redirect( $order->get_checkout_order_received_url() );
            exit;
        }

        // 校验会话号和订单里记的是否一致（防串单）
        $saved_session = (string) $order->get_meta( '_jirvs_session_id', true );
        if ( '' === $session_id || ( '' !== $saved_session && $session_id !== $saved_session ) ) {
            wc_add_notice( '支付信息校验失败，请联系店主。', 'error' );
            wp_safe_redirect( wc_get_checkout_url() );
            exit;
        }

        // ---- 向 Jirvs 查询这笔的真实状态 ----
        $api_result = $this->jirvs_api_get( '/api/v1/checkout/sessions/' . rawurlencode( $session_id ) );
        if ( is_wp_error( $api_result ) ) {
            // 查不到不代表没付：让买家先去"我的订单"看，Webhook 稍后会补上
            $order->add_order_note( 'Jirvs 状态查询失败（' . $api_result->get_error_message() . '），等待异步通知。' );
            wc_add_notice( '正在确认付款结果，请稍后在"我的订单"中查看。', 'notice' );
            wp_safe_redirect( $order->get_checkout_order_received_url() );
            exit;
        }

        $status = isset( $api_result['status'] ) ? $api_result['status'] : '';

        if ( 'complete' === $status || 'succeeded' === $status ) {
            // 真的付成功了：标已付款、减库存、清空购物车
            $order->payment_complete();
            $order->add_order_note( 'Jirvs 收款成功，会话 ' . $session_id . '。' );
            wc_add_notice( '付款成功，感谢您的购买！', 'success' );
            wp_safe_redirect( $order->get_checkout_order_received_url() );
            exit;
        }

        // 还没付 / 已取消 / 失败：带回结账页，让买家换方式或重试
        $order->add_order_note( '买家从 Jirvs 返回，支付未完成（状态：' . $status . '）。' );
        wc_add_notice( '付款未完成，您可以重新尝试或选择其他支付方式。', 'notice' );
        wp_safe_redirect( wc_get_checkout_url() );
        exit;
    }

    // ================= 下面是内部工具函数 =================

    /**
     * 调 Jirvs API（POST）。自动带上 API Key，出错时返回 WP_Error（带中文说明）。
     *
     * @param string $path  接口路径，如 /api/v1/checkout/sessions
     * @param array  $body  请求参数
     * @return array|WP_Error
     */
    private function jirvs_api_post( $path, array $body ) {
        $resp = wp_remote_post(
            $this->api_base . $path,
            array(
                'timeout' => 20,
                'headers' => array(
                    'Content-Type' => 'application/json',
                    // Jirvs 用 x-api-key 头做身份校验
                    'x-api-key'    => $this->api_key,
                ),
                'body'    => wp_json_encode( $body ),
            )
        );
        return $this->parse_api_response( $resp );
    }

    /**
     * 调 Jirvs API（GET）。同样自动带 API Key。
     *
     * @param string $path 接口路径
     * @return array|WP_Error
     */
    private function jirvs_api_get( $path ) {
        $resp = wp_remote_get(
            $this->api_base . $path,
            array(
                'timeout' => 20,
                'headers' => array(
                    'x-api-key' => $this->api_key,
                ),
            )
        );
        return $this->parse_api_response( $resp );
    }

    /**
     * 统一解析 Jirvs API 返回：把各种失败翻译成买家能看懂的中文。
     *
     * @param array|WP_Error $resp wp_remote_* 的原始返回
     * @return array|WP_Error 成功返回数组，失败返回 WP_Error
     */
    private function parse_api_response( $resp ) {
        // 1. 连不上服务器（DNS、超时、SSL……）
        if ( is_wp_error( $resp ) ) {
            return new WP_Error( 'network', '网络连接失败，请检查服务器能否访问 Jirvs API。' );
        }

        $code = (int) wp_remote_retrieve_response_code( $resp );
        $data = json_decode( (string) wp_remote_retrieve_body( $resp ), true );

        // 2. 401：Key 不对
        if ( 401 === $code ) {
            $msg = isset( $data['error'] ) ? $data['error'] : 'API Key 无效';
            return new WP_Error( 'auth', '商户配置错误（' . $msg . '），请联系店主。' );
        }

        // 3. 400：参数问题（比如商户没开通收款通道）
        if ( 400 === $code ) {
            $msg = isset( $data['error'] ) ? $data['error'] : '请求参数有误';
            return new WP_Error( 'bad_request', $msg );
        }

        // 4. 其他非 2xx
        if ( $code < 200 || $code >= 300 ) {
            $msg = isset( $data['error'] ) ? $data['error'] : ( 'Jirvs 服务异常（HTTP ' . $code . '）' );
            return new WP_Error( 'server', $msg );
        }

        // 5. 成功
        return is_array( $data ) ? $data : array();
    }
}
