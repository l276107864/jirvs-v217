// 事件总线：平台统一事件的内存日志 + 按 payment_id 转发到商户的 webhook_url。
// 对标 Jirvs 的 Webhook 能力：结构化事件通知交易状态变更。

function createEventBus() {
  const log = [];
  const routes = new Map(); // payment_id -> webhook_url
  let seq = 0;

  function register(payment_id, webhook_url) {
    if (payment_id && webhook_url) routes.set(payment_id, webhook_url);
  }

  async function emit(event) {
    seq += 1;
    const entry = {
      id: `evt_${Date.now()}_${seq}`,
      ...event,
      emitted_at: new Date().toISOString(),
    };
    log.unshift(entry);
    if (log.length > 200) log.pop();

    const url = event.payment_id ? routes.get(event.payment_id) : null;
    if (url) {
      entry.forwarded_to = url;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-event-type': event.type,
            'x-event-id': entry.id,
          },
          body: JSON.stringify(entry),
          signal: AbortSignal.timeout(8000),
        });
        entry.forward_status = res.status;
      } catch (err) {
        entry.forward_status = 'error: ' + err.message;
      }
    }
    return entry;
  }

  function recent(limit = 50) {
    return log.slice(0, limit);
  }

  return { register, emit, recent };
}

module.exports = { createEventBus };
