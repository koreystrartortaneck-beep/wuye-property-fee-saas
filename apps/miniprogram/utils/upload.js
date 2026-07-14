const config = require('../config');
const { getToken } = require('./request');

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
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (res) => resolve(res.fileID),
        fail: (err) => reject(new Error((err && err.errMsg) || '上传失败')),
      });
    });
  }
  // 自有服务器直传（回滚模式）
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: config.baseURL + '/owner/upload',
      filePath,
      name: 'file',
      header: { Authorization: getToken() ? `Bearer ${getToken()}` : '' },
      success: (res) => {
        try {
          const body = JSON.parse(res.data);
          if (body.code === 0) resolve(body.data.url);
          else reject(new Error(body.message || '上传失败'));
        } catch (e) {
          reject(new Error('上传失败'));
        }
      },
      fail: (err) => reject(new Error((err && err.errMsg) || '上传失败')),
    });
  });
}

/** 图片标识 → 可访问地址（列表/预览用）。cloud:// 与 http 直接透传，老路径拼服务器根。 */
function imageUrl(relative) {
  if (!relative) return '';
  if (relative.startsWith('cloud://') || relative.startsWith('http')) return relative;
  // baseURL 形如 http://host:port/wuye/api/v1 → 根为 http://host:port/wuye
  const root = config.baseURL.replace(/\/api\/v1$/, '');
  return root + relative;
}

module.exports = { uploadImage, imageUrl };
