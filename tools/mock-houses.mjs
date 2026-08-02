#!/usr/bin/env node
/**
 * 造/清理体验用的房屋数据。
 *
 * 为什么要有这个脚本，而不是手点后台：
 * 200 户手点是不可能的，而 CSV 导入没有配套的「撤销」——
 * 一旦导错，后台只能一条条改，200 条就是 200 次点击。
 * 造数据的工具必须自带清理，否则它造出来的就是垃圾。
 *
 *   node tools/mock-houses.mjs create [户数]   默认 200
 *   node tools/mock-houses.mjs list            看现在有多少
 *   node tools/mock-houses.mjs clean           删掉本脚本造的全部房屋与小区
 *
 * 凭据从环境变量读，不写进代码：
 *   ADMIN_USER=xxx ADMIN_PASS=xxx node tools/mock-houses.mjs create
 */

const API = process.env.API_BASE
  || 'https://wuye-api-285165-10-1456585997.sh.run.tcloudbase.com/api/v1';

/*
 * 所有本脚本造的数据都带这个前缀，清理时按它来认。
 * 不用「创建时间」之类的启发式判断 —— 那会误删物业真实录入的数据。
 */
const MARK = '【体验数据】';
const COMMUNITIES = [
  { name: `${MARK}云顶花园`, address: '体验用，可随时删除', houses: null }, // houses=null → 用命令行给的户数
  { name: `${MARK}江畔新村`, address: '体验用，可随时删除', houses: 12 },
];

const user = process.env.ADMIN_USER;
const pass = process.env.ADMIN_PASS;
if (!user || !pass) {
  console.error('请先设置 ADMIN_USER / ADMIN_PASS 环境变量');
  process.exit(1);
}

async function call(path, { method = 'GET', body } = {}, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  /*
   * code!==0 必须抛。这个接口族一律返回 HTTP 200，
   * 只看 res.ok 会把每一个业务失败都当成成功 —— 脚本会一路「成功」地什么都没做。
   */
  if (json.code !== 0) throw new Error(`${path} → ${json.code} ${json.message}`);
  return json.data;
}

const login = () =>
  call('/admin/auth/login', { method: 'POST', body: { username: user, password: pass } })
    .then((d) => d.token);

/** 每 20 户一栋、每栋 2 单元、每单元 5 层 —— 房号形状贴近真实小区 */
function buildRows(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const building = Math.floor(i / 20) + 1;
    const unit = Math.floor((i % 20) / 10) + 1;
    const floor = Math.floor((i % 10) / 2) + 1;
    const room = (i % 2) + 1;
    const no = `${floor}0${room}`;
    rows.push({
      type: 'RESIDENCE',
      building: String(building),
      unit: String(unit),
      room: no,
      code: `${building}-${unit}-${no}`,
      displayName: `${building}栋${unit}单元${no}`,
      area: 88 + (i % 40),
      ownerName: `业主${String(i + 1).padStart(3, '0')}`,
    });
  }
  return rows;
}

async function findCommunities(token) {
  const d = await call('/admin/communities?page=1&pageSize=100', {}, token);
  return (d.list || []).filter((c) => c.name.startsWith(MARK));
}

async function create(token, count) {
  for (const spec of COMMUNITIES) {
    const existing = (await findCommunities(token)).find((c) => c.name === spec.name);
    const community = existing
      || (await call('/admin/communities', {
        method: 'POST',
        body: { name: spec.name, address: spec.address },
      }, token));
    console.log(`${existing ? '已存在' : '已创建'}小区：${spec.name}`);

    const rows = buildRows(spec.houses ?? count);
    const res = await call('/admin/houses/import', {
      method: 'POST',
      body: { communityId: community.id, rows },
    }, token);
    console.log(`  房屋：新增 ${res.created} · 更新 ${res.updated} · 失败 ${res.failed.length}`);
    for (const f of res.failed.slice(0, 3)) console.log(`    第 ${f.index + 1} 行：${f.reason}`);
  }
}

async function list(token) {
  for (const c of await findCommunities(token)) {
    const d = await call(`/admin/houses?communityId=${c.id}&page=1&pageSize=1`, {}, token);
    console.log(`${c.name}  房屋 ${d.total} 套  (${c.id})`);
  }
}

async function clean(token) {
  /*
   * 每个小区独立成败。
   * 第一版没有这层 try：清理时第一个小区在最后一步抛了异常，
   * 整个脚本当场退出，第二个小区连碰都没碰到 —— 而我看到的输出
   * 只有一个报错，很容易以为「只有那一个有问题」。
   * 批量清理工具卡住一个就停，等于把剩下的悄悄漏掉了。
   */
  const problems = [];
  for (const c of await findCommunities(token)) {
    try {
      await cleanOne(token, c);
    } catch (e) {
      problems.push(`${c.name}：${e.message}`);
      console.log(`${c.name}：清理未完成 —— ${e.message}`);
    }
  }
  if (problems.length) {
    console.log(`\n${problems.length} 个小区未清理干净，处理上面的原因后再跑一次 clean`);
    process.exitCode = 1;
  }
}

async function cleanOne(token, c) {
  {
    let removed = 0;
    const blocked = [];
    // 逐页取：删掉一页之后后面的内容会前移，所以每轮都重新取第一页
    for (;;) {
      const d = await call(`/admin/houses?communityId=${c.id}&page=1&pageSize=100`, {}, token);
      const list = (d.list || []).filter((h) => !blocked.includes(h.id));
      if (list.length === 0) break;
      for (const h of list) {
        try {
          await call(`/admin/houses/${h.id}`, { method: 'DELETE' }, token);
          removed += 1;
        } catch (e) {
          /*
           * 挂了账单/绑定的房屋删不掉，这是对的（后端在保护数据）。
           * 记下来跳过，不要因为一条卡住就整批停下 ——
           * 也不要静默吞掉：不说的话，「清理完了」就是句假话。
           */
          blocked.push(h.id);
          console.log(`  跳过 ${h.code}：${e.message.replace(/^.*→ \d+ /, '')}`);
        }
      }
    }
    console.log(`${c.name}：删除 ${removed} 套${blocked.length ? `，${blocked.length} 套有数据挂着未删` : ''}`);

    if (blocked.length === 0) {
      await call(`/admin/communities/${c.id}`, { method: 'DELETE' }, token);
      console.log(`  小区已删除`);
    } else {
      console.log(`  小区保留（还有房屋）——处理完挂着的数据后再跑一次 clean`);
    }
  }
}

const cmd = process.argv[2] || 'list';
const count = Number(process.argv[3]) || 200;
const token = await login();
if (cmd === 'create') await create(token, count);
else if (cmd === 'clean') await clean(token);
else await list(token);
