-- finance_backfill: 历史数据回填（数据迁移，无结构变更）。
-- 幂等可重入：全部语句以 WHERE NOT EXISTS / 状态判定收敛，重复执行不产生副作用或重复行。
-- 本迁移是独立可部署检查点，不修改任何已应用迁移。

-- 1) 强制停用全部 FORMULA 规则（无论启用与否）。停用后不可再启用，只能转换或退役。
UPDATE `FeeRule` SET `enabled` = 0 WHERE `ruleType` = 'FORMULA' AND `enabled` = 1;

-- 2) 为既有 BillRun 生成一个 PUBLISHED 的 RULE 批次（确定性 id 保证可重入）。
INSERT INTO `BillBatch` (
  `id`, `tenantId`, `communityId`, `batchNo`, `period`, `title`, `source`, `ruleId`,
  `status`, `totalRows`, `validRows`, `invalidRows`, `totalAmount`, `publishedAt`, `createdAt`, `updatedAt`
)
SELECT
  CONCAT('batch_', r.`id`), r.`tenantId`, f.`communityId`,
  CONCAT('RULE-', r.`period`, '-', r.`ruleId`), r.`period`, f.`name`, 'RULE', r.`ruleId`,
  'PUBLISHED', r.`total`, r.`generated`, r.`skipped`, 0.00,
  COALESCE(r.`finishedAt`, r.`startedAt`), r.`startedAt`, r.`startedAt`
FROM `BillRun` r
JOIN `FeeRule` f ON f.`id` = r.`ruleId`
WHERE NOT EXISTS (SELECT 1 FROM `BillBatch` b WHERE b.`id` = CONCAT('batch_', r.`id`));

-- 3) 既有账单回填为「已发布的 RULE 账单」：有出账批次的关联到派生批次。
UPDATE `Bill` b
JOIN `BillRun` r ON r.`id` = b.`billRunId`
SET
  b.`batchId` = CONCAT('batch_', r.`id`),
  b.`source` = 'RULE',
  b.`publishedAt` = COALESCE(b.`publishedAt`, r.`finishedAt`, r.`startedAt`, b.`createdAt`)
WHERE b.`billRunId` IS NOT NULL AND b.`batchId` IS NULL AND b.`status` <> 'DRAFT';

-- 无出账批次的历史账单：仅标记来源与发布时间，不强行归批。
UPDATE `Bill` b
SET
  b.`source` = 'RULE',
  b.`publishedAt` = COALESCE(b.`publishedAt`, b.`createdAt`)
WHERE b.`billRunId` IS NULL AND b.`source` IS NULL AND b.`status` <> 'DRAFT';

-- 批次金额与有效行数从已回填账单汇总（可重入：每次以聚合结果覆盖）。
UPDATE `BillBatch` b
JOIN (
  SELECT `batchId`, SUM(`amount`) AS amt, COUNT(*) AS cnt
  FROM `Bill` WHERE `batchId` IS NOT NULL GROUP BY `batchId`
) s ON s.`batchId` = b.`id`
SET b.`totalAmount` = s.amt, b.`validRows` = s.cnt
WHERE b.`source` = 'RULE';

-- 4) 仅当某支付的全部 PaymentBill 账单同属一个小区时，回填 Payment.communityId。
--    跨小区历史订单保持 communityId=NULL，其小区集合由 PaymentBill 派生。
UPDATE `Payment` p
JOIN (
  SELECT pb.`paymentId` AS pid, MIN(bl.`communityId`) AS cid, COUNT(DISTINCT bl.`communityId`) AS ccount
  FROM `PaymentBill` pb
  JOIN `Bill` bl ON bl.`id` = pb.`billId`
  GROUP BY pb.`paymentId`
) x ON x.pid = p.`id`
SET p.`communityId` = x.cid
WHERE p.`communityId` IS NULL AND x.ccount = 1;
