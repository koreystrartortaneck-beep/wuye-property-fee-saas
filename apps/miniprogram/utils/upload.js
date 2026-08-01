const config = require('../config');
const { getToken } = require('./request');

/**
 * 单张图片的上传超时。
 *
 * 比接口的 12 秒宽得多：照片动辄几 MB，弱网下十几秒是正常的。
 * 但**必须有上限** —— 报修提交时外面套着 wx.showLoading({ mask: true })，
 * mask 会锁死整个界面，上传挂住就等于业主完全没有出路。
 * 支付那次的「一直转圈」是同一个缺陷（请求没超时），这里只是换了个文件。
 */
const UPLOAD_TIMEOUT_MS = 30000;

/**
 * 给上传任务加超时。
 *
 * 不能靠参数里的 timeout：wx.uploadFile 支持，而
 * **wx.cloud.uploadFile 的文档里没有这个参数** —— 而真机跑的恰恰是云存储那条。
 * 所以统一用「计时器 + task.abort()」：两个 API 都返回 UploadTask，都有 abort()。
 * abort() 之后 fail 回调会被触发，所以 settled 标记要防重复 reject。
 */
function withTimeout(startUpload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (task && task.abort) task.abort();
      } catch (e) {
        // abort 本身失败也要把这次上传判为超时，否则调用方永远等不到结果
      }
      reject(new Error('图片上传超时，请检查网络后重试'));
    }, UPLOAD_TIMEOUT_MS);
    const task = startUpload(done(resolve), done(reject));
  });
}

/**
 * 上传单张图片，返回可持久化的图片标识。
 * 云托管模式 → 微信云存储 fileID（cloud://...，业主端 <image> 可直接渲染）；
 * 否则 → 老服务器相对路径 /uploads/...。
 */
function uploadImage(filePath) {
  // 云模式：直传微信云存储（免备案、真机可用）
  if (config.useCloud && wx.cloud) {
    const ext = (filePath.match(/\.(\w+)(?:\?|$)/) || [null, 'jpg'])[1].toLowerCase();
    const cloudPath = `tickets/${Date.now()}-${Math.floor(Math.random() * 1e8)}.${ext}`;
    return withTimeout((ok, fail) =>
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (res) => ok(res.fileID),
        fail: (err) => fail(new Error((err && err.errMsg) || '上传失败')),
      }),
    );
  }
  // 自有服务器直传（回滚模式）
  return withTimeout((ok, fail) =>
    wx.uploadFile({
      url: config.baseURL + '/owner/upload',
      filePath,
      name: 'file',
      header: { Authorization: getToken() ? `Bearer ${getToken()}` : '' },
      timeout: UPLOAD_TIMEOUT_MS,
      success: (res) => {
        try {
          const body = JSON.parse(res.data);
          if (body.code === 0) ok(body.data.url);
          else fail(new Error(body.message || '上传失败'));
        } catch (e) {
          fail(new Error('上传失败'));
        }
      },
      fail: (err) => fail(new Error((err && err.errMsg) || '上传失败')),
    }),
  );
}

/** 图片标识 → 可访问地址（列表/预览用）。cloud:// 与 http 直接透传，老路径拼服务器根。 */
function imageUrl(relative) {
  if (!relative) return '';
  if (relative.startsWith('cloud://') || relative.startsWith('http')) return relative;
  // baseURL 形如 http://host:port/wuye/api/v1 → 根为 http://host:port/wuye
  const root = config.baseURL.replace(/\/api\/v1$/, '');
  return root + relative;
}

module.exports = { uploadImage, imageUrl, UPLOAD_TIMEOUT_MS };
