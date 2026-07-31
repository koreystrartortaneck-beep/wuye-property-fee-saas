// e2e 测试前加载 apps/api/.env（DATABASE_URL 等）
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.WX_MODE = process.env.WX_MODE || 'mock';
process.env.PAY_MODE = process.env.PAY_MODE || 'mock';
process.env.ALLOW_MOCK_PAYMENTS = process.env.ALLOW_MOCK_PAYMENTS || 'true';
/*
 * Mock 微信服务的显式开关。
 *
 * wx.module.ts 里是 fail-closed 的：WX_MODE=mock 时若没有 ALLOW_MOCK_WX=true 就抛错
 * （防止生产误用 mock 微信，这个设计是对的）。但 setup-env 当时只补了
 * ALLOW_MOCK_PAYMENTS，漏了这一个 —— **于是整套 e2e（24 个文件 136 条）
 * 从那以后一直起不来**，报的是「Mock 微信服务必须显式配置」而不是断言失败，
 * 看起来像环境问题，就一直没人管。
 *
 * 这套 e2e 才是唯一能发现「模块装配/依赖注入坏了」的测试 ——
 * src 下的单测都是直接 new 类 + 注入 mock，绕过了 Nest 的容器。
 */
process.env.ALLOW_MOCK_WX = process.env.ALLOW_MOCK_WX || 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
