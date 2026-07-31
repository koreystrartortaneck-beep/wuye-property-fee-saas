import {
  buildWebhookBody,
  detectWebhookFlavor,
  interpretWebhookResponse,
  renderAlertText,
  type AlertDeliveryPayload,
} from './alert.service';

/**
 * 告警投递的成败判定。
 *
 * 缺陷经过：readiness 报 ALERT_DESTINATION 不健康（OPS_ALERT_WEBHOOK 未配置）。
 * 顺着看投递器，发现两个问题 —— 都是「配好了也收不到，而记录显示正常」：
 *
 *   1) 只看 HTTP 状态码。企业微信/钉钉群机器人在参数错误、机器人被移出群、
 *      触发频率限制时返回的都是 **HTTP 200 + {"errcode":93000}**，
 *      于是全部被记成「告警已投递」。真出事时没人收到，而系统说一切正常 ——
 *      比没有告警更糟，因为它会让人停止怀疑。
 *   2) 发的是我们自定义的 JSON。群机器人只认自己的结构，收到别的直接拒 ——
 *      也就是说，运维把地址粘进来之后，一条都收不到。
 */
const PAYLOAD: AlertDeliveryPayload = {
  alertType: 'PAYMENT_CALLBACK_REJECTED',
  severity: 'CRITICAL',
  tenantId: 't1',
  communityId: null,
  title: '微信支付回调验签失败',
  summary: '连续 3 次验签失败',
  context: { foo: 'bar' },
  occurrences: 3,
};

describe('按域名自动适配群机器人格式', () => {
  it('企业微信与钉钉各自识别，其它按原样 JSON', () => {
    // 自动判定省掉一个能填错的配置项：运维只需粘地址
    expect(detectWebhookFlavor('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x')).toBe('wecom');
    expect(detectWebhookFlavor('https://oapi.dingtalk.com/robot/send?access_token=x')).toBe('dingtalk');
    expect(detectWebhookFlavor('https://ops.example.com/hook')).toBe('raw');
  });

  it('企业微信的结构是 msgtype/text.content', () => {
    const body = JSON.parse(buildWebhookBody(PAYLOAD, 'wecom'));
    expect(body.msgtype).toBe('text');
    expect(typeof body.text.content).toBe('string');
    // 关键信息必须在正文里：只发个标题的话，收到告警的人还得自己去后台查
    expect(body.text.content).toContain('CRITICAL');
    expect(body.text.content).toContain('微信支付回调验签失败');
    expect(body.text.content).toContain('3');
  });

  it('自建 webhook 收到的仍是完整结构化载荷', () => {
    // raw 形态不能被「顺手也改成文本」——自建接收端要靠字段做路由/统计
    const body = JSON.parse(buildWebhookBody(PAYLOAD, 'raw'));
    expect(body.alertType).toBe('PAYMENT_CALLBACK_REJECTED');
    expect(body.occurrences).toBe(3);
  });

  it('文本里不包含 context——它可能带敏感字段', () => {
    // 告警上下文可能含手机号/房号；群消息是转发面最大的地方
    expect(renderAlertText(PAYLOAD)).not.toContain('bar');
  });
});

describe('HTTP 200 不等于投递成功', () => {
  it('errcode 非 0 判失败，并带上原因', () => {
    const r = interpretWebhookResponse(200, '{"errcode":93000,"errmsg":"invalid webhook url"}');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('93000');
    expect(r.error).toContain('invalid webhook url');
  });

  it('errcode 为 0 判成功', () => {
    expect(interpretWebhookResponse(200, '{"errcode":0,"errmsg":"ok"}').ok).toBe(true);
  });

  it('没有 errcode 字段时以状态码为准', () => {
    // 自建 webhook 通常不返回 errcode，不能因此判失败
    expect(interpretWebhookResponse(200, '{"received":true}').ok).toBe(true);
    expect(interpretWebhookResponse(204, '').ok).toBe(true);
  });

  it('非 JSON 响应体不算失败', () => {
    // 很多自建接收端直接回 "OK" 文本
    expect(interpretWebhookResponse(200, 'OK').ok).toBe(true);
  });

  it('4xx/5xx 一律失败', () => {
    expect(interpretWebhookResponse(403, '').ok).toBe(false);
    expect(interpretWebhookResponse(500, '{"errcode":0}').ok).toBe(false);
  });

  it('errcode 是字符串数字也要认', () => {
    // 少数网关会把数字序列化成字符串，判定不能因此漏掉失败
    expect(interpretWebhookResponse(200, '{"errcode":"93000"}').ok).toBe(false);
  });
});
