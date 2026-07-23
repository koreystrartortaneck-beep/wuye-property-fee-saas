-- 管理员会话加固（Task 3）
-- 新增会话/锁定/改密字段；对全部存量管理员强制改密并递增 tokenVersion，
-- 使迁移前签发的 JWT 立即失效。演示账号的禁用在 seed 中按环境处理。

ALTER TABLE `AdminUser`
  ADD COLUMN `failedLoginCount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `lockedUntil` DATETIME(3) NULL,
  ADD COLUMN `tokenVersion` INT NOT NULL DEFAULT 0,
  ADD COLUMN `passwordChangedAt` DATETIME(3) NULL,
  ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false;

UPDATE `AdminUser`
  SET `mustChangePassword` = true,
      `tokenVersion` = `tokenVersion` + 1;
