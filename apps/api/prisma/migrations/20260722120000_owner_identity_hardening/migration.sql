-- 业主身份加固（Task 12）：仅新增可空/带默认列，向后兼容，不回改历史迁移。
-- WxUser：owner 令牌版本（吊销）、手机绑定证据时间、注销匿名化标记。
ALTER TABLE `WxUser`
  ADD COLUMN `tokenVersion` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `phoneBoundAt` DATETIME(3) NULL,
  ADD COLUMN `deletedAt` DATETIME(3) NULL;

-- HouseBinding：手机匹配证据时间、失效解绑标记（区分人工审批证据）。
ALTER TABLE `HouseBinding`
  ADD COLUMN `phoneMatchedAt` DATETIME(3) NULL,
  ADD COLUMN `revokedAt` DATETIME(3) NULL,
  ADD COLUMN `revokeReason` VARCHAR(191) NULL;
