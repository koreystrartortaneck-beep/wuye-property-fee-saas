-- 每人限领的**数据库级**保证。
--
-- 此前 claim() 在事务外 count 一次再进事务，是典型的 TOCTOU：
-- 同一用户并发两次领取都读到 count=0（limit=1），都通过校验，各自建一条记录 ——
-- 拿到超额的券，而每张券都是实打实的抵扣金额。库存那道有原子保证
-- （claimedQty < totalQty 的条件 updateMany），限领这道没有。
--
-- claimSeq 是「这是该用户领的第几张」，配合唯一约束把限领变成插入冲突：
-- 并发时必有一方拿到 P2002，无法超发。应用层的 count 退化为快速失败与友好文案。
ALTER TABLE `UserCoupon` ADD COLUMN `claimSeq` INT NOT NULL DEFAULT 0;

-- 回填必须在建唯一索引之前：若已有用户对同一张券领过多张（旧代码允许），
-- 直接建索引会让 migrate deploy 失败，而容器启动命令就是 migrate deploy ——
-- 那等于整个服务起不来。按领取时间编号，历史数据一律保留。
UPDATE `UserCoupon` uc
JOIN (
  SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `couponId`, `wxUserId` ORDER BY `claimedAt`, `id`) - 1 AS rn
  FROM `UserCoupon`
) t ON t.`id` = uc.`id`
SET uc.`claimSeq` = t.rn;

CREATE UNIQUE INDEX `UserCoupon_couponId_wxUserId_claimSeq_key` ON `UserCoupon`(`couponId`, `wxUserId`, `claimSeq`);
