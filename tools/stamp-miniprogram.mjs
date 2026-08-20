#!/usr/bin/env node
/**
 * 给小程序打一个「代码指纹」，显示在「我的」页底部。
 *
 * 为什么需要：业主端每次改完，唯一的验证方式是在开发者工具里点「编译」，
 * 而**编译有没有真的生效、模拟器里跑的是不是最新代码，屏幕上看不出来**。
 * 2026-08-02 就卡在这里 —— 只能靠「数菜单项个数」这种土办法反推版本，
 * 而一旦某次改动不含可见差异（纯逻辑、纯超时），就彻底无从判断。
 *
 * 做法：对 apps/miniprogram 下的全部源码算一个内容哈希，取前 7 位。
 *
 * 用内容哈希而不是 git 提交号，是因为提交号有先后死结：
 * 要在提交里写下本次提交的哈希是不可能的，只能写上一个 —— 显示的版本永远差一拍。
 * 内容哈希没有这个问题：改了就变，没改就不变，且**任何人任何时候都能重算出来对账**。
 *
 *   node tools/stamp-miniprogram.mjs          写入 utils/version.js
 *   node tools/stamp-miniprogram.mjs --check  只校验，不一致时退出码 1
 *   node tools/stamp-miniprogram.mjs --print  只打印指纹
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'apps/miniprogram');
const VERSION_FILE = path.join(MP, 'utils/version.js');

/*
 * version.js 自己必须排除在外，否则自指：写进去的值会改变下一次的计算结果，
 * 永远收敛不了。node_modules / miniprogram_npm 是产物，也排除。
 */
const EXCLUDE_DIRS = new Set(['node_modules', 'miniprogram_npm', '.git']);
const SOURCE_EXT = new Set(['.js', '.json', '.wxml', '.wxss', '.wxs']);
/*
 * 开发者工具在每台机器上生成的**私有**配置(编译模式、本机路径等),已 gitignore、
 * 不会随代码上传。它不是点开头的文件,所以躲过了上面那条规则 ——
 * 2026-08-20 CI 首次运行抓到:同一份代码在我的 Mac 上算出 069cb34,
 * 在 Linux 上是 f96dd78,差别就是这一个文件的有无。
 * 指纹的用途是回答「手机上跑的是不是这份代码」,它必须只取**会上传的源码**;
 * 随本机杂物漂移的指纹比没有指纹更危险 —— 它会让人以为版本对上了。
 */
const EXCLUDE_FILES = new Set(['project.private.config.json']);

function collect(dir, root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    /*
     * 点开头的一律跳过。它们不是会被打包上传的源码，而是测试临时落下的探针
     * （如 utils/.upload-timeout-probe.js）。若把它们算进指纹，
     * 指纹就会随「当时有没有别的测试在跑」而变 —— 一个会漂的指纹毫无意义。
     */
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) collect(full, root, out);
    } else if (
      SOURCE_EXT.has(path.extname(entry.name)) &&
      !EXCLUDE_FILES.has(entry.name) &&
      full !== path.join(root, 'utils/version.js')
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * @param root 小程序根目录。测试传副本目录，这样验证「改了源码指纹要变」
 *   不必去动真实工作区 —— 动真实工作区既会和并发的其他测试打架，
 *   也有把用户未提交的改动弄丢的风险（干过一次）。
 */
export function computeStamp(root = MP) {
  const h = createHash('sha256');
  for (const file of collect(root, root)) {
    // 路径一起进哈希：只改文件名（重命名、删除后新增同内容文件）也要能被发现
    h.update(path.relative(root, file).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(file));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 7);
}

export function readStamp() {
  if (!fs.existsSync(VERSION_FILE)) return null;
  return /BUILD\s*=\s*'([^']*)'/.exec(fs.readFileSync(VERSION_FILE, 'utf8'))?.[1] ?? null;
}

function render(stamp) {
  return `/**
 * 小程序代码指纹 —— 由 tools/stamp-miniprogram.mjs 生成，不要手改。
 *
 * 显示在「我的」页底部。用途是回答一个每次改动都会碰到的问题：
 * **我现在看到的，是不是最新代码？**
 *
 * 它是 apps/miniprogram 全部源码的内容哈希（本文件除外）。
 * 屏幕上的值和 \`node tools/stamp-miniprogram.mjs --print\` 的输出一致，
 * 就说明模拟器/手机上跑的确实是当前工作区的代码。
 */
const BUILD = '${stamp}';

module.exports = { BUILD };
`;
}

const mode = process.argv[2];
const stamp = computeStamp();

if (mode === '--print') {
  console.log(stamp);
} else if (mode === '--check') {
  const current = readStamp();
  if (current === stamp) {
    console.log(`指纹一致：${stamp}`);
  } else {
    console.error(`指纹过期：文件里写的是 ${current ?? '(缺失)'}，实际应为 ${stamp}`);
    console.error('请运行：node tools/stamp-miniprogram.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(VERSION_FILE, render(stamp));
  console.log(`已写入指纹：${stamp}`);
}
