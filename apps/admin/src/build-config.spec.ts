import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 生产构建参数必须固化在仓库里，不能只存在于操作者的记忆里。
 *
 * 线上后台挂在 /wuye-admin/ 下、API 走 /wuye/api/v1。这两个值只在构建时生效：
 *   · base 不对 → 产物里的资源路径是 /assets/...，部署后全部 404，页面白屏
 *   · VITE_API_BASE 不对 → 前端请求 /api/v1，nginx 上没有这个位置，所有接口失败
 *
 * 而 `pnpm -r build`（仓库级构建）跑的是默认的 `build`，产物不能直接部署 ——
 * 本轮就是跑完仓库级构建才发现这一点：dist/ 里躺着一份 base 错误的产物，
 * 谁顺手 rsync 一下线上就白屏（nginx 那次白屏已经演示过后果）。
 */
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('生产构建参数', () => {
  it('build:prod 存在且同时固定 base 与 API 前缀', () => {
    const cmd = PKG.scripts['build:prod'];
    expect(cmd, 'package.json 缺少 build:prod').toBeTruthy();
    expect(cmd).toContain('--base=/wuye-admin/');
    expect(cmd).toContain('VITE_API_BASE=/wuye/api/v1');
  });

  it('默认 build 不带这些参数——所以不能拿它的产物部署', () => {
    /*
     * 这条不是在要求「default build 必须错」，而是钉住两者的区别：
     * 若哪天把参数塞进默认 build，就该同时删掉 build:prod 与这条断言，
     * 而不是留下两条都能用、但只有一条对的路径。
     */
    expect(PKG.scripts.build).toBe('vite build');
  });

  it('api.ts 的 API_BASE 有回退值，dev 下不依赖环境变量', () => {
    // dev 走 vite 代理的 /api/v1；回退值丢了会让本地开发直接报错
    const src = readFileSync(join(__dirname, 'api.ts'), 'utf8');
    expect(src).toMatch(/VITE_API_BASE\s*\|\|\s*'\/api\/v1'/);
  });
});
