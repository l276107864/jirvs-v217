// 地理围栏中间件：阻止受限地区 IP 发起支付
//
// 给非技术人员看的设计说明：
// - "用户在哪个国家"这件事，生产环境由 Cloudflare / WAF 在网络边缘判定，
//   它会把国家代码写进请求头（CF-IPCountry）。本中间件只做应用层二次校验，
//   属于纵深防御（边缘拦一道，应用再拦一道）。
// - 沙盒里没有 Cloudflare，所以提供测试开关做联调验证（见 ALLOW_TEST_GEO_HEADER）。
//
// 环境变量：
//   GEO_FENCE_ENABLED      true=开启, 其他=关闭（默认关闭，沙盒默认关闭，不影响本地测试）
//   GEO_BLOCKED_COUNTRIES  逗号分隔的 ISO 国家代码，默认 CN
//   ALLOW_TEST_GEO_HEADER  true=允许用 X-Test-Country 请求头模拟用户所在国家（仅沙盒联调）
//
// 生产部署清单：
//   1. 在 Cloudflare 开启 IP Geolocation（自动写入 CF-IPCountry 头）；
//   2. 在 Cloudflare WAF 建 geo-blocking 规则，先在边缘拦截；
//   3. 本服务设置 GEO_FENCE_ENABLED=true，做应用层兜底。

function resolveCountry(req) {
  // 测试头：仅沙盒联调使用，生产环境务必关闭 ALLOW_TEST_GEO_HEADER
  if (process.env.ALLOW_TEST_GEO_HEADER === 'true') {
    const t = req.get('x-test-country');
    if (t) return String(t).trim().toUpperCase();
  }
  // 生产：信任上游 CDN / WAF 写入的国家头
  const h = req.get('cf-ipcountry') || req.get('x-country-code');
  if (h) return String(h).trim().toUpperCase();
  return '';
}

function blockedSet() {
  return (process.env.GEO_BLOCKED_COUNTRIES || 'CN')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function geoFence(req, res, next) {
  if (process.env.GEO_FENCE_ENABLED !== 'true') return next(); // 默认关闭
  const country = resolveCountry(req);
  if (country && blockedSet().includes(country)) {
    return res.status(403).json({
      error: '根据合规要求，当前地区暂不支持使用本服务',
      code: 'GEO_BLOCKED',
    });
  }
  next();
}

module.exports = { geoFence, resolveCountry, blockedSet };
