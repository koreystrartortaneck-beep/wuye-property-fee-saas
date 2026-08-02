import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { GlobalExceptionFilter } from './http-exception.filter';

/**
 * 校验错误必须以中文呈现：此前直传 class-validator 原文，
 * 收费员会看到 "houseType must be one of the following values: ..."。
 */
describe('GlobalExceptionFilter 校验错误汉化', () => {
  const filter = new GlobalExceptionFilter();

  function run(message: string | string[]): { code: number; message: string } {
    let payload: { code: number; message: string } = { code: 0, message: '' };
    const res = {
      status: () => res,
      json: (b: { code: number; message: string }) => {
        payload = b;
        return res;
      },
    } as never;
    filter.catch(new BadRequestException({ message }), {
      // getRequest 必须给：过滤器要靠请求方法区分 P2003 的两种相反方向
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST' }) }),
    } as never);
    return payload;
  }

  it('枚举取值不合法 → 中文字段名 + 可选值', () => {
    const r = run(['houseType must be one of the following values: RESIDENCE, PARKING, SHOP']);
    expect(r.code).toBe(ErrorCode.VALIDATION.code);
    expect(r.message).toBe('适用房屋类型 取值不合法（仅支持：RESIDENCE, PARKING, SHOP）');
  });

  it('上下界 → 中文', () => {
    expect(run(['dueDays must not be greater than 90']).message).toBe('缴费期限 不能大于 90');
    expect(run(['area must not be less than 0.01']).message).toBe('面积 不能小于 0.01');
  });

  it('必填 / 类型 → 中文', () => {
    expect(run(['requestId should not be empty']).message).toBe('请填写请求标识');
    expect(run(['pageSize must be an integer number']).message).toBe('每页条数 必须是整数');
    expect(run(['unitPrice must be a number conforming to the specified constraints']).message).toBe(
      '单价 必须是数字',
    );
  });

  it('嵌套字段名取末段', () => {
    expect(run(['rows.0.area must not be less than 0.01']).message).toBe('面积 不能小于 0.01');
  });

  it('无法识别的信息原样返回，不吞掉', () => {
    expect(run(['某个自定义中文提示']).message).toBe('某个自定义中文提示');
  });
});

/**
 * 「路由没匹配上」必须回非 200。
 *
 * 2026-08-01 事故的最深一层。§7 规定 HTTP 始终 200、错误放在 body.code 里，
 * 而这条规则对**未匹配路由**同样生效时，代价是致命的：
 *
 * 微信支付回调按 HTTP 状态码判定投递结果，200 = 「已受理，不再重试」。
 * WX_PAY_NOTIFY_URL 只要配错一点（最常见是漏掉 /api/v1 前缀），
 * 微信 POST 过来就命中未匹配路由、拿到 HTTP 200，于是认为投递成功、
 * **永久不再重试**。业主的钱扣了、账单永远不变，而系统里毫无痕迹：
 * 没进验签代码所以没告警，微信侧显示成功所以不重试。
 *
 * 生产实测（改之前）：
 *   POST /payment/wxpay/notify        → HTTP 200 {"code":40400,...}   ← 灾难
 *   POST /api/v1/payment/wxpay/notify → HTTP 401 {"code":"FAIL",...}  ← 正确
 */
describe('未匹配路由必须回 HTTP 404', () => {
  const filter = new GlobalExceptionFilter();

  function run(exception: unknown): { status: number; body: { code: number; message: string } } {
    let status = 0;
    let body = { code: 0, message: '' };
    const res = {
      status: (s: number) => {
        status = s;
        return res;
      },
      json: (b: { code: number; message: string }) => {
        body = b;
        return res;
      },
    } as never;
    filter.catch(exception, {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'GET' }) }),
    } as never);
    return { status, body };
  }

  it('NotFoundException（Nest 路由未匹配）→ HTTP 404', () => {
    const { NotFoundException } = require('@nestjs/common') as typeof import('@nestjs/common');
    const r = run(new NotFoundException());
    expect(r.status).toBe(404);
  });

  it('响应体不变——两个前端都只读 body.code，改状态码不能顺手改了契约', () => {
    const { NotFoundException } = require('@nestjs/common') as typeof import('@nestjs/common');
    expect(run(new NotFoundException()).body).toEqual(ErrorCode.NOT_FOUND);
  });

  it('业务的「记录不存在」仍然是 HTTP 200——§7 对业务错误照旧', () => {
    /*
     * 这条是边界：业务查不到一条记录是正常的业务结果，不是路由问题。
     * 若连它也改成 404，前端每次查空都会在控制台看到红色报错。
     */
    const { BizException } = require('./biz.exception') as typeof import('./biz.exception');
    const r = run(new BizException(ErrorCode.NOT_FOUND));
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(ErrorCode.NOT_FOUND.code);
  });

  it('其它业务错误一律仍是 HTTP 200', () => {
    const { BadRequestException, UnauthorizedException, ForbiddenException } =
      require('@nestjs/common') as typeof import('@nestjs/common');
    expect(run(new BadRequestException({ message: ['x should not be empty'] })).status).toBe(200);
    expect(run(new UnauthorizedException()).status).toBe(200);
    expect(run(new ForbiddenException()).status).toBe(200);
    expect(run(new Error('boom')).status).toBe(200);
  });

  it('全库没有一处直接 new NotFoundException——这是上面那条改动成立的前提', () => {
    /*
     * 改动的安全性完全依赖这个不变式：NotFoundException 分支只可能来自 Nest 路由。
     * 哪天有人在业务代码里 new NotFoundException()，那处的业务 404 就会变成
     * HTTP 404，前端控制台开始飘红 —— 而没人会想到是这条过滤器改的。
     * 所以把不变式本身钉住，并指明正确写法。
     */
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.ts') && !e.name.includes('.spec.')) out.push(p);
      }
      return out;
    };
    const src = path.join(__dirname, '..');
    const offenders = walk(src).filter(
      (f) =>
        !f.endsWith(path.join('common', 'http-exception.filter.ts')) &&
        /new NotFoundException/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => f.slice(src.length + 1))).toEqual([]);
  });
});
