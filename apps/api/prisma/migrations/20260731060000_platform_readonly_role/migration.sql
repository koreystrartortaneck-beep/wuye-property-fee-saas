-- 新增「只读平台管理员」角色。
--
-- SUPER_ADMIN 是「平台视角 + 全权」的合体：RolesGuard 对它无条件放行、租户隔离扩展
-- 对它不设过滤，所以日常的平台巡检、排查业主投诉、给客户演示都只能动用这个全权账号，
-- 而它一旦被盗即为全系统沦陷（能退款、能冲正、能暂停收款、能读全部业主手机号）。
--
-- PLATFORM_READONLY 的读范围与超管一致（可跨租户），但任何非 GET 请求一律被
-- RolesGuard 拒绝——按 HTTP 方法而不是靠 @Roles 注解，因为管理端 53 个写端点里
-- 有 45 个既没有方法级也没有类级注解，靠注解等于默认放行。
--
-- 只加枚举值，不改任何现有行：MySQL 的 ENUM 追加值是在线操作，不锁表。
ALTER TABLE `AdminUser`
  MODIFY `role` ENUM('SUPER_ADMIN', 'PLATFORM_READONLY', 'TENANT_ADMIN', 'STAFF') NOT NULL;
