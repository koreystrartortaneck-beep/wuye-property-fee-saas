-- 审计动作新增 DELETE。
--
-- 起因：房屋原来只能导入和停用，删不掉 —— 导错一批（房号规则搞错、导到错的小区、
-- 试用期造的测试数据）之后，错误数据永久留在库里，还会挡住删小区
-- （删小区要求下面没有房屋，而房屋删不掉）。
--
-- 补上删除能力时发现 AuditAction 里没有 DELETE。用 UPDATE 顶替是不行的：
-- 审计日志是「房屋去哪了」唯一查得到的地方，把删除记成修改，
-- 等于在这个唯一可信的地方写了假话。
--
-- 只加枚举值，不改任何现有行：MySQL 的 ENUM 追加值是在线操作，不锁表。
ALTER TABLE `AuditLog`
  MODIFY `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'PUBLISH', 'CANCEL', 'PAY', 'REFUND', 'RECONCILE', 'INVOICE', 'RECOVER') NOT NULL;
