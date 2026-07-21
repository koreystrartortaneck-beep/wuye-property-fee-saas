const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function loadFresh(relativePath) {
  const modulePath = path.join(projectRoot, relativePath);
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test('wx-login 返回 40100 时不触发递归登录', async () => {
  let calls = 0;
  global.getApp = () => ({ globalData: { user: null } });
  global.wx = {
    cloud: {
      callContainer(options) {
        calls += 1;
        if (calls === 1) {
          options.success({ data: { code: 40100, message: '微信登录失败' } });
          return;
        }
        options.fail({ errMsg: '不应重试登录接口' });
      },
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    login: ({ success }) => success({ code: 'second-login-code' }),
  };

  const { request } = loadFresh('apps/miniprogram/utils/request.js');

  await assert.rejects(
    request('/auth/wx-login', { method: 'POST', data: { code: 'first-login-code' }, silent: true }),
    (error) => error.code === 40100,
  );
  assert.equal(calls, 1);
});

test('隐私同意回放包含按钮 ID 并在组件销毁时注销监听', () => {
  let definition;
  let privacyListener;
  let removedListener;
  global.Component = (value) => {
    definition = value;
  };
  global.wx = {
    onNeedPrivacyAuthorization(listener) {
      privacyListener = listener;
    },
    offNeedPrivacyAuthorization(listener) {
      removedListener = listener;
    },
    showToast: () => {},
  };

  loadFresh('apps/miniprogram/components/privacy-popup/privacy-popup.js');
  const resolved = [];
  const instance = {
    _resolve: null,
    setData: () => {},
  };

  definition.lifetimes.attached.call(instance);
  privacyListener((value) => resolved.push(value));
  definition.methods.onAgree.call(instance);
  definition.lifetimes.detached.call(instance);

  assert.deepEqual(resolved, [{ event: 'agree', buttonId: 'agree-privacy-btn' }]);
  assert.equal(removedListener, privacyListener);

  const wxml = fs.readFileSync(
    path.join(projectRoot, 'apps/miniprogram/components/privacy-popup/privacy-popup.wxml'),
    'utf8',
  );
  assert.match(wxml, /id="agree-privacy-btn"/);
});
