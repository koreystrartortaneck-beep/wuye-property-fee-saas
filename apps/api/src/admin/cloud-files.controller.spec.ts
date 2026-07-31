import { CloudFilesController } from './cloud-files.controller';
import { runWithTenant } from '../tenant/tenant-cls';

/**
 * cloud:// 文件的归属校验。
 *
 * 这条校验此前被我记为「已知未修：留待后续，需要先统一 images 的存储格式」。
 * 重新核对后那个理由不成立 —— Ticket.images 与 WorkLog.images 都是 Json 字符串数组、
 * ServiceItem.coverImage 是字符串列，三处形状明确、可直接查。
 *
 * 不校验的后果：任何 STAFF 把任意 fileID POST 过来就能换到可下载的临时链接，
 * 包括同一云环境下**别的物业公司**的业主报修照片（可能拍到户内、门牌、身份材料）。
 * fileID 不易猜（时间戳 + 6 字节随机），但「不易猜」不是授权。
 *
 * 修的时候有个必须一起处理的连锁反应：管理员刚上传、还没保存工作日志时，
 * 那个 fileID 不在任何记录里 —— 校验一加上，他就看不到自己刚传的图。
 * 所以 /admin/upload 改为一并返回 viewUrl，前端用它预览，不再回头解析。
 */

function makeCtrl(ownedRows: Array<{ fileId: string }>) {
  const queryRaw = jest.fn(async () => ownedRows);
  const resolveFileUrls = jest.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, `https://tmp/${id}`])),
  );
  const ctrl = new CloudFilesController(
    { resolveFileUrls } as never,
    { raw: { $queryRaw: queryRaw } } as never,
  );
  return { ctrl, queryRaw, resolveFileUrls };
}

const OWNED = 'cloud://env.7775-env/admin/202607/mine.png';
const OTHERS = 'cloud://env.7775-env/admin/202607/someone-else.png';

describe('只解析属于本租户的文件', () => {
  it('本租户的文件正常返回临时 URL', async () => {
    const { ctrl, resolveFileUrls } = makeCtrl([{ fileId: OWNED }]);
    const out = await runWithTenant('t1', () => ctrl.urls({ fileIds: [OWNED] }));
    expect(out[OWNED]).toBe(`https://tmp/${OWNED}`);
    expect(resolveFileUrls).toHaveBeenCalledWith([OWNED]);
  });

  it('别人的文件不解析，且不向微信发起请求', async () => {
    /*
     * 关键：未授权的 id 不能进入 resolveFileUrls ——
     * 否则临时链接已经生成，只是没返回给这一次调用，白泄露一次。
     */
    const { ctrl, resolveFileUrls } = makeCtrl([]);
    const out = await runWithTenant('t1', () => ctrl.urls({ fileIds: [OTHERS] }));
    expect(out).toEqual({});
    expect(resolveFileUrls).toHaveBeenCalledWith([]);
  });

  it('混合请求只放行属于自己的那些', async () => {
    const { ctrl, resolveFileUrls } = makeCtrl([{ fileId: OWNED }]);
    const out = await runWithTenant('t1', () => ctrl.urls({ fileIds: [OWNED, OTHERS] }));
    expect(Object.keys(out)).toEqual([OWNED]);
    expect(resolveFileUrls).toHaveBeenCalledWith([OWNED]);
  });

  it('未授权的 id 不抛错——一屏里混进旧 id 不该让整页图片全裂', async () => {
    /*
     * 记录被删了、id 还在前端缓存里，是正常情况。
     * 整批抛错会让这一页所有图片都打不开，而前端对缺失的 key 已按「图裂」处理。
     */
    const { ctrl } = makeCtrl([]);
    await expect(runWithTenant('t1', () => ctrl.urls({ fileIds: [OTHERS] }))).resolves.toEqual({});
  });

  it('空请求直接返回，不查库也不外呼', async () => {
    const { ctrl, queryRaw, resolveFileUrls } = makeCtrl([]);
    const out = await runWithTenant('t1', () => ctrl.urls({ fileIds: [] }));
    expect(out).toEqual({});
    expect(queryRaw).not.toHaveBeenCalled();
    expect(resolveFileUrls).not.toHaveBeenCalled();
  });

  it('重复 id 去重后只查一次', async () => {
    const { ctrl, resolveFileUrls } = makeCtrl([{ fileId: OWNED }]);
    await runWithTenant('t1', () => ctrl.urls({ fileIds: [OWNED, OWNED, OWNED] }));
    expect(resolveFileUrls).toHaveBeenCalledWith([OWNED]);
  });

  it('没有租户上下文时一律不授权（fail closed）', async () => {
    /*
     * 管理端路由都会被 TenantContextInterceptor 设上上下文；走到这里说明装配出了问题。
     * 那种情况下宁可图片打不开，也不要把校验降级成放行 ——
     * 「上下文缺失就放行」是这类漏洞最常见的形态。
     */
    const { ctrl, queryRaw, resolveFileUrls } = makeCtrl([{ fileId: OWNED }]);
    const out = await ctrl.urls({ fileIds: [OWNED] });
    expect(out).toEqual({});
    expect(queryRaw).not.toHaveBeenCalled();
    expect(resolveFileUrls).toHaveBeenCalledWith([]);
  });

  it('平台视角不限租户，但仍要求文件存在于某个租户的记录里', async () => {
    /*
     * 超管未选租户时不该被挡住查图；但也不能退回「任意 fileID 都换」——
     * 那才是这个端点最初的敞口（同一云环境下别的应用的文件）。
     */
    const { ctrl, resolveFileUrls } = makeCtrl([{ fileId: OWNED }]);
    const out = await runWithTenant(null, () => ctrl.urls({ fileIds: [OWNED, OTHERS] }));
    expect(Object.keys(out)).toEqual([OWNED]);
    expect(resolveFileUrls).toHaveBeenCalledWith([OWNED]);
  });
});

describe('刚上传还没保存的图必须能预览', () => {
  it('/admin/upload 的云分支返回 viewUrl', () => {
    /*
     * 这是上面那条归属校验能成立的前提：
     * 若上传只返回 cloud:// fileId，前端只能回头调 /cloud-files/urls 去换，
     * 而此刻这张图还没进任何记录，必然被拒 —— 管理员看到一个空白图框。
     */
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, '..', 'upload', 'upload.controller.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/return \{ url: fileId, viewUrl \}/);
    // 换 URL 失败不能连带让上传失败：图已经在云上了，丢掉 fileId 等于白传一次
    expect(src).toMatch(/\.catch\(\(\) => ''\)/);
  });

  it('后台预览用 viewUrl，不再回头解析', () => {
    const src = require('node:fs')
      .readFileSync(
        require('node:path').join(__dirname, '..', '..', '..', 'admin', 'src', 'views', 'WorkLogs.vue'),
        'utf8',
      )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const body = src.slice(src.indexOf('async function doUpload'), src.indexOf('function onRemove'));
    expect(body).toContain('viewUrl');
    expect(body).not.toContain('resolveCloud');
  });
});
