-- M4 · 管理员手机号（小程序免密登录的凭据）
--
-- 物业人员不用电脑。管理端做进业主小程序（分包），认证方式：
-- 微信授权手机号（微信/运营商核验过的本人号码）匹配 AdminUser.phone
-- → 换发管理员令牌。强度等同短信验证码登录；名单由 TENANT_ADMIN 管理、变更审计。
--
-- 全局唯一：一个手机号只能对应一个管理员账号 ——
-- 允许重复的话，换发令牌时无法确定给哪个账号（哪个租户）的权限。
ALTER TABLE `AdminUser` ADD COLUMN `phone` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `AdminUser_phone_key` ON `AdminUser`(`phone`);
