/* 生成演示 PNG → 上传微信云存储 → 回填工作日志 images。仅演示数据，幂等可重跑。
 * 需环境：WX_APPID / WX_SECRET / WX_CLOUD_ENV / DATABASE_URL（在 api 容器内均已具备）。 */
const zlib = require('zlib');
const { PrismaClient } = require('@prisma/client');

// ---- 极简 PNG 编码（RGB，带柔和对角渐变，够演示用）----
const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function makePng(w, h, base) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      raw[o++] = Math.round(base[0] * (1 - t) + 255 * t * 0.6);
      raw[o++] = Math.round(base[1] * (1 - t) + 255 * t * 0.6);
      raw[o++] = Math.round(base[2] * (1 - t) + 255 * t * 0.6);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const APPID = process.env.WX_APPID, SECRET = process.env.WX_SECRET, ENV = process.env.WX_CLOUD_ENV;

async function token() {
  const r = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`);
  const d = await r.json();
  if (!d.access_token) throw new Error('token 失败: ' + JSON.stringify(d));
  return d.access_token;
}
async function upload(tk, path, buf) {
  const m = await (await fetch(`https://api.weixin.qq.com/tcb/uploadfile?access_token=${tk}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env: ENV, path }),
  })).json();
  if (m.errcode || !m.url) throw new Error('取上传地址失败: ' + JSON.stringify(m));
  const fd = new FormData();
  fd.append('key', path);
  fd.append('Signature', m.authorization);
  fd.append('x-cos-security-token', m.token);
  fd.append('x-cos-meta-fileid', m.cos_file_id);
  fd.append('file', new Blob([new Uint8Array(buf)], { type: 'image/png' }), 'demo.png');
  const up = await fetch(m.url, { method: 'POST', body: fd });
  if (up.status !== 204 && up.status !== 200) throw new Error('上传失败 HTTP ' + up.status);
  return m.file_id;
}

(async () => {
  const prisma = new PrismaClient();
  const tk = await token();
  const mk = (name, color) => upload(tk, `worklogs/demo-${name}-${Date.now()}.png`, makePng(800, 600, color));
  const [insp1, insp2, green1] = await Promise.all([
    mk('insp1', [64, 90, 130]),
    mk('insp2', [90, 70, 110]),
    mk('green1', [70, 130, 90]),
  ]);
  console.log('uploaded fileIDs:', { insp1, insp2, green1 });
  const r1 = await prisma.workLog.updateMany({ where: { title: '早班消防巡检' }, data: { images: [insp1, insp2] } });
  const r2 = await prisma.workLog.updateMany({ where: { title: '中心花园修剪' }, data: { images: [green1] } });
  console.log('updated worklogs:', r1.count, r2.count);
  await prisma.$disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
