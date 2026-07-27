import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守护「用了但没导入」这类运行时崩溃。
 *
 * 起因：Payments.vue 里加了 genRequestId(...) 调用却漏在 import 清单中，
 * 退款/冲正/线下现金核销三个资金按钮点击后直接抛
 * ReferenceError: genRequestId is not defined，全部静默失效。
 * 而 `vite build` 不做未定义引用检查、vitest 又只覆盖 finance.ts，
 * 「构建通过 + 测试通过」完全没能拦住。
 *
 * 本测试对每个 .vue 的 <script setup> 做轻量静态检查：
 * 凡调用了共享模块导出的函数，就必须在该文件的 import 中出现。
 */

const SRC = path.join(__dirname);
const VIEWS = path.join(SRC, 'views');

/** 从共享模块收集所有导出的函数名 */
function exportedFunctions(file: string): string[] {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');
  return [...src.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

/** 从共享模块收集导出的常量名（如 *_LABEL 映射表） */
function exportedConsts(file: string): string[] {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');
  return [...src.matchAll(/export\s+const\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

const SHARED = ['finance.ts', 'composables.ts', 'api.ts', 'badges.ts', 'export.ts', 'nav.ts'];
const SHARED_SYMBOLS = new Set<string>();
for (const f of SHARED) {
  for (const n of exportedFunctions(f)) SHARED_SYMBOLS.add(n);
  for (const n of exportedConsts(f)) SHARED_SYMBOLS.add(n);
}

/**
 * 三方库里最常被漏导入的组合式 API 与全局提示。
 * 实际踩过：Houses.vue 使用了 useRoute 却未 import，运行时整页（含侧栏）
 * 直接白屏——而首版守卫只检查自有共享模块，没能拦住。
 */
for (const n of [
  'useRoute',
  'useRouter',
  'ref',
  'reactive',
  'computed',
  'watch',
  'onMounted',
  'onUnmounted',
  'nextTick',
  'ElMessage',
  'ElMessageBox',
]) {
  SHARED_SYMBOLS.add(n);
}

/** 取出该 .vue 文件所有 import 进来的标识符 */
function importedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1];
    // 具名导入 { a, b as c, type D }
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const raw = part.trim().replace(/^type\s+/, '');
        if (!raw) continue;
        const alias = raw.split(/\s+as\s+/);
        names.add((alias[1] ?? alias[0]).trim());
      }
    }
    // 默认导入 / 命名空间导入
    const dflt = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
    for (const token of dflt.split(/\s+/)) {
      const t = token.replace(/^\*\s*as\s*/, '').trim();
      if (t && t !== 'as' && /^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  return names;
}

const vueFiles = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.vue'));

describe('后台页面：共享模块符号必须导入后再使用', () => {
  it('存在待检查的页面文件', () => {
    expect(vueFiles.length).toBeGreaterThan(10);
  });

  for (const file of vueFiles) {
    it(`${file} 无「用了但没导入」的共享符号`, () => {
      const src = fs.readFileSync(path.join(VIEWS, file), 'utf8');
      const scriptMatch = src.match(/<script[^>]*>([\s\S]*?)<\/script>/);
      const script = scriptMatch ? scriptMatch[1] : '';
      if (!script) return;

      // 本文件内自行定义的同名符号（函数/常量）不算缺失
      const localDefs = new Set<string>([
        ...[...script.matchAll(/function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
        ...[...script.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
      ]);
      const imported = importedNames(script);

      const missing: string[] = [];
      for (const sym of SHARED_SYMBOLS) {
        /*
         * 用法形态有三种，早期只认前两种，导致 ElMessageBox.confirm(...) 这类
         * 成员访问在 4 个页面漏检（点「删除」直接 ReferenceError）：
         *   1) 调用     sym(...)
         *   2) 下标取值 sym[...]
         *   3) 成员访问 sym.foo
         * 加 `.` 后即被拦住。仍要求后面跟符号，避免匹配到同名字符串字面量。
         */
        const used = new RegExp(`\\b${sym}\\s*[(\\[.]`).test(script);
        if (used && !imported.has(sym) && !localDefs.has(sym)) missing.push(sym);
      }

      expect(
        missing,
        `${file} 使用了但未导入：${missing.join(', ')} —— 运行时会抛 ReferenceError，点击即静默失效`,
      ).toEqual([]);
    });
  }
});
