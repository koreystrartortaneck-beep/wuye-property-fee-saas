import { WxPayBillProvider } from './wxpay-bill.provider';
import { MockWechatBillProvider, hashBill } from './wechat-bill.provider';

/**
 * 起因：生产环境的对账一直在跑，但 WECHAT_BILL_PROVIDER 被无条件绑到 Mock，
 * 每次都返回空账期，于是本地全部交易被判成 CHANNEL_MISSING，批次却写 COMPLETED。
 * 线上特征：channelRecordCount 恒 0、channelFileHash 恒为 SHA256("[]")、耗时 15–34ms。
 *
 * 这些用例锁住两件事：真实渠道能把 CSV 解析成渠道记录；wxpay 模式绝不退回 Mock。
 */
describe('WxPayBillProvider 真实对账单渠道', () => {
  const TRADE_CSV = [
    '交易时间,公众账号ID,商户号,商户订单号,微信支付订单号,交易状态,应结订单金额',
    '`2026-07-27 16:08:08,`wx9e8,`1748438704,`WY20260727060126,`42000012,`SUCCESS,`2.50',
    '总交易单数,总交易额',
    '`1,`2.50',
  ].join('\n');

  const REFUND_CSV = [
    '交易时间,商户订单号,商户退款单号,退款状态,退款金额',
    '`2026-07-27 16:20:00,`WY20260727060126,`RF-WY20260727060126,`SUCCESS,`2.50',
  ].join('\n');

  function providerWith(csv: string) {
    const wxpay = { downloadBillCsv: jest.fn().mockResolvedValue(csv) };
    return { provider: new WxPayBillProvider(wxpay as never), wxpay };
  }

  const input = {
    merchantAccountId: 'acct',
    mchid: '1748438704',
    appid: 'wx9e8',
    businessDate: '2026-07-27',
  };

  it('交易账单：解析出渠道笔数与金额，且 hash 取自原始文件而非解析结果', async () => {
    const { provider, wxpay } = providerWith(TRADE_CSV);
    const bill = await provider.downloadBill({ ...input, billType: 'TRANSACTION' });

    expect(wxpay.downloadBillCsv).toHaveBeenCalledWith('TRANSACTION', '2026-07-27');
    expect(bill.recordCount).toBe(1);
    expect(bill.totalAmountCents).toBe(250);
    expect(bill.trades[0].outTradeNo).toBe('WY20260727060126');
    expect(bill.trades[0].tradeState).toBe('SUCCESS');
    // 关键：不能再是 SHA256("[]")——那正是 Mock 留在生产库里的指纹
    expect(bill.fileHash).toBe(hashBill(TRADE_CSV));
    expect(bill.fileHash).not.toBe(hashBill(JSON.stringify([])));
  });

  it('退款账单：只解析退款记录，交易列表为空', async () => {
    const { provider, wxpay } = providerWith(REFUND_CSV);
    const bill = await provider.downloadBill({ ...input, billType: 'REFUND' });

    expect(wxpay.downloadBillCsv).toHaveBeenCalledWith('REFUND', '2026-07-27');
    expect(bill.trades).toEqual([]);
    expect(bill.recordCount).toBe(1);
    expect(bill.totalAmountCents).toBe(250);
    expect(bill.refunds[0].outRefundNo).toBe('RF-WY20260727060126');
  });

  it('下载失败必须抛出，不能降级成空账期（否则又变成把本地交易全判为差异）', async () => {
    const wxpay = { downloadBillCsv: jest.fn().mockRejectedValue(new Error('HTTP 500')) };
    const provider = new WxPayBillProvider(wxpay as never);
    await expect(provider.downloadBill({ ...input, billType: 'TRANSACTION' })).rejects.toThrow('HTTP 500');
  });

  it('空账期（当天确实没有交易）返回 0 笔，但 hash 是真实文件的哈希', async () => {
    const emptyCsv = '交易时间,商户订单号,微信支付订单号,交易状态,应结订单金额\n';
    const { provider } = providerWith(emptyCsv);
    const bill = await provider.downloadBill({ ...input, billType: 'TRANSACTION' });
    expect(bill.recordCount).toBe(0);
    expect(bill.fileHash).toBe(hashBill(emptyCsv));
  });
});

/**
 * 依赖注入的选择逻辑单独测：这是「对账是真的还是假的」的唯一开关。
 * 直接复刻 ReconciliationModule 里的 useFactory，避免为了测一个分支去启动整个 Nest 容器。
 */
describe('对账单渠道按 PAY_MODE 选择', () => {
  const mock = new MockWechatBillProvider();
  const real = new WxPayBillProvider({ downloadBillCsv: jest.fn() } as never);

  function pick() {
    if (process.env.PAY_MODE === 'wxpay') return real;
    if (process.env.PAY_MODE === 'mock') {
      if (process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
        throw new Error('Mock 对账单渠道必须显式配置 ALLOW_MOCK_PAYMENTS=true');
      }
      return mock;
    }
    throw new Error('PAY_MODE 必须明确配置为 mock 或 wxpay');
  }

  const saved = { mode: process.env.PAY_MODE, allow: process.env.ALLOW_MOCK_PAYMENTS };
  afterEach(() => {
    process.env.PAY_MODE = saved.mode;
    process.env.ALLOW_MOCK_PAYMENTS = saved.allow;
  });

  it('wxpay 模式必须用真实渠道，绝不退回 Mock', () => {
    process.env.PAY_MODE = 'wxpay';
    expect(pick()).toBe(real);
  });

  it('mock 模式需显式开 ALLOW_MOCK_PAYMENTS，否则启动即失败', () => {
    process.env.PAY_MODE = 'mock';
    delete process.env.ALLOW_MOCK_PAYMENTS;
    expect(() => pick()).toThrow('ALLOW_MOCK_PAYMENTS');
    process.env.ALLOW_MOCK_PAYMENTS = 'true';
    expect(pick()).toBe(mock);
  });

  it('PAY_MODE 未配置时启动失败，而不是悄悄用 Mock 对账', () => {
    delete process.env.PAY_MODE;
    expect(() => pick()).toThrow('PAY_MODE');
  });
});

/**
 * 真实微信账单末尾带汇总段，且汇总段列名与明细段完全不同。
 *
 * 线上实证：接入真实下载后第一次对账（2026-07-22），当天实际只有 1 笔交易，
 * 却解析出 3 条「渠道记录」，多出来两条的订单号是 `0.00` 和 `申请退款总金额`
 * ——正是汇总段被当成明细行。原判断 row['商户订单号'] === '总交易单数' 在
 * columns:true 下永远不成立，因为汇总段是按明细表头映射的，列全部错位。
 */
describe('对账单汇总段必须被截掉', () => {
  const REAL_TRADE_CSV = [
    '交易时间,公众账号ID,商户号,商户订单号,微信支付订单号,交易状态,应结订单金额,申请退款金额',
    '`2026-07-22 13:23:00,`wx9e8,`1748438704,`WY20260722813378,`4200002612,`SUCCESS,`0.01,`0.00',
    '总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额',
    '`1,`0.01,`0.00,`0.00,`0.00,`0.01,`0.00',
  ].join('\n');

  const REAL_REFUND_CSV = [
    '交易时间,商户订单号,商户退款单号,退款状态,退款金额',
    '`2026-07-24 23:31:40,`WY20260724751305,`RF-WY20260724751305,`SUCCESS,`0.01',
    '总退款单数,退款总金额',
    '`1,`0.01',
  ].join('\n');

  it('交易账单：只解析出真实明细，不把汇总行当成交易', async () => {
    const wxpay = { downloadBillCsv: jest.fn().mockResolvedValue(REAL_TRADE_CSV) };
    const bill = await new WxPayBillProvider(wxpay as never).downloadBill({
      merchantAccountId: 'a', mchid: '1748438704', appid: 'wx9e8',
      businessDate: '2026-07-22', billType: 'TRANSACTION',
    });
    expect(bill.recordCount).toBe(1);
    expect(bill.trades.map((t) => t.outTradeNo)).toEqual(['WY20260722813378']);
    // 这两个是修复前实际出现在生产库里的假「订单号」
    expect(bill.trades.map((t) => t.outTradeNo)).not.toContain('0.00');
    expect(bill.trades.map((t) => t.outTradeNo)).not.toContain('申请退款总金额');
    expect(bill.totalAmountCents).toBe(1);
  });

  it('退款账单：同样截掉汇总段', async () => {
    const wxpay = { downloadBillCsv: jest.fn().mockResolvedValue(REAL_REFUND_CSV) };
    const bill = await new WxPayBillProvider(wxpay as never).downloadBill({
      merchantAccountId: 'a', mchid: '1748438704', appid: 'wx9e8',
      businessDate: '2026-07-24', billType: 'REFUND',
    });
    expect(bill.recordCount).toBe(1);
    expect(bill.refunds.map((r) => r.outRefundNo)).toEqual(['RF-WY20260724751305']);
    expect(bill.totalAmountCents).toBe(1);
  });

  it('只有表头与汇总段（当天零交易）时返回 0 笔，而不是把汇总行算成交易', async () => {
    const emptyWithSummary = [
      '交易时间,公众账号ID,商户号,商户订单号,微信支付订单号,交易状态,应结订单金额',
      '总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额',
      '`0,`0.00,`0.00,`0.00,`0.00,`0.00',
    ].join('\n');
    const wxpay = { downloadBillCsv: jest.fn().mockResolvedValue(emptyWithSummary) };
    const bill = await new WxPayBillProvider(wxpay as never).downloadBill({
      merchantAccountId: 'a', mchid: '1', appid: 'w',
      businessDate: '2026-07-25', billType: 'TRANSACTION',
    });
    expect(bill.recordCount).toBe(0);
    expect(bill.totalAmountCents).toBe(0);
  });
});
