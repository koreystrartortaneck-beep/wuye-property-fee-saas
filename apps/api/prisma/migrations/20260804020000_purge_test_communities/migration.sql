-- 一次性清理:删掉联调/体验期造的三个测试小区**名下的审计记录**。
--
-- ⚠ 这个文件在 2026-08-04 02:00 左右的部署里失败过一次(库里 _prisma_migrations
-- 标了 failed,后续 migrate deploy 全被 P3009 挡住 → 新容器起不来,老容器继续服务)。
-- 已核实失败发生在「删审计」之前:三个小区的审计条数(1/24/200)一条没少。
-- 恢复办法:改这个文件 + 启动前 `migrate resolve --rolled-back` 让它重放
-- (这是 Prisma 文档给的失败迁移恢复路径)。
--
-- 相比失败的那一版,这一版去掉了两处**拿服务可用性去赌**的东西:
--   1) `SET @c1 := ...` 会话变量 —— 依赖「整个文件跑在同一条连接上」,那是引擎实现细节。
--      现在 id 全写字面量。
--   2) `DELETE FROM Community` —— 只要撞上任何一个没想到的外键就让 migrate deploy 失败,
--      而迁移失败 = 服务起不来。删小区交给 /admin/maintenance/purge:
--      它会逐张点名还剩什么、返回一个 HTTP 错误,而不是把整个服务拖下线。
--
-- 为什么清审计只能靠迁移:AuditLog 上有 BEFORE UPDATE / BEFORE DELETE 两个触发器,
-- 摘掉它们是 DDL,而 Prisma 查询引擎走预处理协议根本执行不了(MySQL 1295)。
-- 只有迁移引擎能做 —— 也就是说运行时任何管理员、任何接口都破不了「审计不可删」。
--
-- 目标(已核实:房屋/账单/批次/收费标准/缴费/工单/公告… 全为 0,只剩审计挡着):
--   cmsbuqzlf0006pxuaj2uv2kq3 【已停用·勿用】自锁验证遗留   审计   1 条
--   cmsbthafr0006r6uaec0nv1pk 【体验数据】江畔新村           审计  24 条
--   cmsbtha8t0001r6uapx4qbtza 【体验数据】云顶花园           审计 200 条
-- 金港城(cmrvmwcrh0008ngu9abaat07q)的审计一行不动。
--
-- 全文可重放:DELETE 都带 WHERE,CREATE TRIGGER 前面一定先 DROP IF EXISTS。
-- 顺带把触发器无条件重建一次 —— 上次失败可能停在两个 DROP 之间,
-- 那会让审计表**静默地**失去保护;重放这段等于顺手修好它。

-- ① 运行痕迹(无业务含义,但有外键指向小区)
DELETE FROM `IdempotencyRecord`  WHERE `communityId` IN ('cmsbuqzlf0006pxuaj2uv2kq3', 'cmsbthafr0006r6uaec0nv1pk', 'cmsbtha8t0001r6uapx4qbtza');
DELETE FROM `OutboxEvent`        WHERE `communityId` IN ('cmsbuqzlf0006pxuaj2uv2kq3', 'cmsbthafr0006r6uaec0nv1pk', 'cmsbtha8t0001r6uapx4qbtza');
DELETE FROM `PaymentEvent`       WHERE `communityId` IN ('cmsbuqzlf0006pxuaj2uv2kq3', 'cmsbthafr0006r6uaec0nv1pk', 'cmsbtha8t0001r6uapx4qbtza');
DELETE FROM `ReconciliationItem` WHERE `communityId` IN ('cmsbuqzlf0006pxuaj2uv2kq3', 'cmsbthafr0006r6uaec0nv1pk', 'cmsbtha8t0001r6uapx4qbtza');
DELETE FROM `ReconciliationRun`  WHERE `communityId` IN ('cmsbuqzlf0006pxuaj2uv2kq3', 'cmsbthafr0006r6uaec0nv1pk', 'cmsbtha8t0001r6uapx4qbtza');
DELETE FROM `RefundAttempt`      WHERE `communityId` IN ('cmsbuqzlf0006pxuaj2uv2kq3', 'cmsbthafr0006r6uaec0nv1pk', 'cmsbtha8t0001r6uapx4qbtza');

-- ② 摘掉 append-only 触发器 —— 唯一的窗口,下面立刻装回
DROP TRIGGER IF EXISTS `AuditLog_before_update_append_only`;
DROP TRIGGER IF EXISTS `AuditLog_before_delete_append_only`;

-- ③ 只删这三个小区的审计行
DELETE FROM `AuditLog` WHERE `communityId` IN ('cmsbuqzlf0006pxuaj2uv2kq3', 'cmsbthafr0006r6uaec0nv1pk', 'cmsbtha8t0001r6uapx4qbtza');

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
