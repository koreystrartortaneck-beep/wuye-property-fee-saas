/** 单元测试配置（src 内 *.spec.ts） */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^@pf/shared$': '<rootDir>/../../../packages/shared/src',
  },
};
