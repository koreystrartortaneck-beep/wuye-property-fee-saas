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
      switchToHttp: () => ({ getResponse: () => res }),
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
