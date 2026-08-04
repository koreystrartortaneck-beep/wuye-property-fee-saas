-- 一次性清理:删掉联调/体验期造的三个测试小区,连它们名下的审计记录。
--
-- 为什么必须是迁移:AuditLog 上有 BEFORE DELETE 触发器(审计不可删),
-- 摘掉它需要 DDL,而 Prisma 查询引擎走预处理协议执行不了 DDL(MySQL 1295)。
-- 只有迁移引擎能做 —— 也就是说清审计这件事必须经过一次代码提交与评审,
-- 运行时任何管理员、任何接口都破不了那条保证。这是有意的。
--
-- 三个目标(均已核实:房屋/账单/批次/收费标准/缴费/工单… 全部为 0):
--   cmsbuqzlf0006pxuaj2uv2kq3 【已停用·勿用】自锁验证遗留   审计 1 条
--   cmsbthafr0006r6uaec0nv1pk 【体验数据】江畔新村           审计 24 条
--   cmsbtha8t0001r6uapx4qbtza 【体验数据】云顶花园           审计 200 条
--
-- 幂等:全部带 WHERE,重跑是空操作(迁移只跑一次,但重放不会出错)。
-- 顺序刻意如此:先清运行痕迹 → 摘触发器 → 只删这三个小区的审计 →
-- **立刻把触发器装回** → 最后才删小区。装回排在删小区之前,
-- 万一最后一步被某个漏掉的外键挡住,审计表也已经恢复保护。

SET @c1 := 'cmsbuqzlf0006pxuaj2uv2kq3';
SET @c2 := 'cmsbthafr0006r6uaec0nv1pk';
SET @c3 := 'cmsbtha8t0001r6uapx4qbtza';

-- ① 运行痕迹(无业务含义,但有外键指向小区)
DELETE FROM `IdempotencyRecord`  WHERE `communityId` IN (@c1, @c2, @c3);
DELETE FROM `OutboxEvent`        WHERE `communityId` IN (@c1, @c2, @c3);
DELETE FROM `PaymentEvent`       WHERE `communityId` IN (@c1, @c2, @c3);
DELETE FROM `ReconciliationItem` WHERE `communityId` IN (@c1, @c2, @c3);
DELETE FROM `ReconciliationRun`  WHERE `communityId` IN (@c1, @c2, @c3);
DELETE FROM `RefundAttempt`      WHERE `communityId` IN (@c1, @c2, @c3);

-- ② 摘掉 append-only 触发器(唯一的窗口,下面立刻装回)
DROP TRIGGER IF EXISTS `AuditLog_before_update_append_only`;
DROP TRIGGER IF EXISTS `AuditLog_before_delete_append_only`;

-- ③ 只删这三个小区的审计行。其它小区(尤其金港城)一行都不动。
DELETE FROM `AuditLog` WHERE `communityId` IN (@c1, @c2, @c3);

-- ④ 立刻装回,与 20260722010300_audit_guards 里的定义逐字一致
CREATE TRIGGER `AuditLog_before_update_append_only`
BEFORE UPDATE ON `AuditLog`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'AuditLog is append-only: UPDATE is forbidden';

CREATE TRIGGER `AuditLog_before_delete_append_only`
BEFORE DELETE ON `AuditLog`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'AuditLog is append-only: DELETE is forbidden';

-- ⑤ 最后删小区本身
DELETE FROM `Community` WHERE `id` IN (@c1, @c2, @c3);
