/**
 * 后台页面存活检查：用 Chrome DevTools Protocol 逐页导航线上后台，
 * 收集 JS 异常 / console 错误 / 4xx-5xx 请求 / 页面是否真的渲染出内容。
 *
 * 为什么需要它：后台有 26 个路由、80 条前端单测，但那些单测全是结构与逻辑断言 ——
 * **没有任何一条会真的把页面加载起来**。而这一天里我改了十几个 .vue 文件，
 * 一次浏览器都没打开过。nginx 那次白屏（正则 location 配错，js/css 全 500）
 * 就是这类问题：单测全绿、部署成功、页面打不开。
 *
 * 只读：只导航，不点任何按钮，不发写请求。
 *
 * 用法：
 *   node tools/admin-page-check.mjs /dashboard /bills /arrears ...
 *   SHOT=/tmp/shots node tools/admin-page-check.mjs /dashboard   # 顺带截图
 *
 * 需要本机装了 Chrome。账号口令从环境变量取，避免写进仓库：
 *   ADMIN_USER=... ADMIN_PASS=... node tools/admin-page-check.mjs /dashboard
 */
// 用 CDP 驱动线上后台：逐页导航，收集 console 错误、失败请求、页面是否有内容。只读，不点任何按钮。
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const BASE = process.env.ADMIN_BASE ?? 'http://58.244.176.174:8443/wuye-admin/';
const API = process.env.API_BASE ?? 'https://wuye-api-285165-10-1456585997.sh.run.tcloudbase.com/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTES = process.argv.slice(2);

const login = async () => {
  const r = await fetch(`${API}/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USER ?? 'admin',
      password: process.env.ADMIN_PASS ?? '',
    }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('登录失败 ' + JSON.stringify(j));
  return j.data;
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1440,900',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--user-data-dir=/tmp/cdp-admin-check', 'about:blank',
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const events = [];
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) throw new Error('拿不到 Chrome 调试目标');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).res(msg.result); pending.delete(msg.id); return; }
    events.push(msg);
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');

  const auth = await login();
  // 先加载一次拿到同源上下文，再写 localStorage
  await send('Page.navigate', { url: BASE });
  await sleep(2500);
  await send('Runtime.evaluate', {
    expression: `
      localStorage.setItem('pf_admin_token', ${JSON.stringify(auth.token)});
      // profile 是登录响应里的嵌套对象，不能从顶层拼 —— 拼出来 role 是 undefined，
      // 顶栏会 fallback 显示「员工」，我第一次就据此误判成产品 bug
      localStorage.setItem('pf_admin_profile', ${JSON.stringify(JSON.stringify(auth.profile))});
      'ok'`,
  });

  const results = [];
  for (const route of ROUTES) {
    events.length = 0;
    await send('Page.navigate', { url: `${BASE}#${route}` });
    await sleep(400);
    await send('Runtime.evaluate', { expression: 'location.reload()' }).catch(() => {});
    await sleep(3200);

    const errs = [];
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') {
        errs.push('EXC ' + (e.params?.exceptionDetails?.exception?.description ?? e.params?.exceptionDetails?.text ?? '').split('\n')[0]);
      }
      if (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error') {
        errs.push('CONSOLE ' + (e.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
      }
      if (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error') {
        errs.push('LOG ' + String(e.params.entry.text).slice(0, 160));
      }
      if (e.method === 'Network.loadingFailed') {
        errs.push('NET ' + (e.params?.errorText ?? ''));
      }
      // 4xx/5xx 要带上是哪个 URL —— 只报「404」定位不到任何东西
      if (e.method === 'Network.responseReceived') {
        const st = e.params?.response?.status ?? 0;
        if (st >= 400) errs.push(`HTTP ${st} ${String(e.params.response.url).replace(/^https?:\/\/[^/]+/, '')}`);
      }
    }
    const probe = await send('Runtime.evaluate', {
      expression: `(() => {
        const t = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
        return JSON.stringify({ len: t.length, head: t.slice(0, 90), cards: document.querySelectorAll('.el-card,.el-table,.block').length });
      })()`,
      returnByValue: true,
    });
    let info = { len: 0, head: '', cards: 0 };
    try { info = JSON.parse(probe.result.value); } catch {}
    results.push({ route, errs: [...new Set(errs)], ...info });
    if (process.env.SHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const { writeFileSync } = await import('node:fs');
      const name = route.replace(/\//g, '_') || '_root';
      writeFileSync(`${process.env.SHOT}/admin${name}.png`, Buffer.from(shot.data, 'base64'));
    }
  }

  for (const r of results) {
    const ok = r.errs.length === 0 && r.len > 60;
    console.log(`${ok ? '✓' : '✗'} ${r.route.padEnd(22)} 文字${String(r.len).padStart(5)} 组件${String(r.cards).padStart(3)}  ${r.head.slice(0, 46)}`);
    for (const e of r.errs.slice(0, 3)) console.log(`    ! ${e}`);
  }
} catch (e) {
  console.error('运行失败:', e.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
}
