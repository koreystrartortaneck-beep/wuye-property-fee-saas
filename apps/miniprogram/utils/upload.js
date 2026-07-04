const config = require('../config');
const { getToken } = require('./request');

/** 上传单张图片，返回服务器相对 URL（/uploads/...） */
function uploadImage(filePath) {
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
          else {
            wx.showToast({ title: body.message || '上传失败', icon: 'none' });
            reject(new Error(body.message));
          }
        } catch (e) {
          reject(e);
        }
      },
      fail: (err) => {
        wx.showToast({ title: '上传失败：' + (err.errMsg || ''), icon: 'none' });
        reject(new Error(err.errMsg));
      },
    });
  });
}

/** 图片完整访问地址（列表/预览用） */
function imageUrl(relative) {
  if (!relative) return '';
  if (relative.startsWith('http')) return relative;
  // baseURL 形如 http://host:port/wuye/api/v1 → 根为 http://host:port/wuye
  const root = config.baseURL.replace(/\/api\/v1$/, '');
  return root + relative;
}

module.exports = { uploadImage, imageUrl };
