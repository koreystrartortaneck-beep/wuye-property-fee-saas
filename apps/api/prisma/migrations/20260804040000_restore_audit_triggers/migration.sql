-- 无条件重建 AuditLog 的 append-only 触发器。
--
-- 起因:20260804020000 在生产上失败过一次,失败点在「摘掉触发器」之后、
-- 「装回触发器」之前的某处。之后那条迁移经 resolve 重放并成功了(审计行确实删掉了),
-- 按理说重放时的 CREATE TRIGGER 也执行了 —— 但生产 readiness 报
-- auditTriggers=0,而它读的是 information_schema。
--
-- 两种可能:①触发器真没了 ②information_schema 经数据库代理查不到。
-- 我暂时分不清,而**两种情况下这个迁移都是对的**:
--   真没了 → 这里补回来
--   只是查不到 → DROP IF EXISTS + CREATE 等价于重建一次,无副作用
-- 「审计不可删」是这套系统最核心的防篡改保证,不该停在「大概还在」上。
--
-- 定义与 20260722010300_audit_guards 逐字一致。可重放。
DROP TRIGGER IF EXISTS `AuditLog_before_update_append_only`;
DROP TRIGGER IF EXISTS `AuditLog_before_delete_append_only`;

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
