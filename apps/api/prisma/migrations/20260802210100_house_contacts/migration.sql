-- M2 · 房屋授权手机号列表（HouseContact）
--
-- 起因：House.ownerPhone 是单字段 —— 一套房只能登记一个手机号，
-- 而业主、家属、租客可能都要看账单；换租时后台改手机号也不会触碰旧绑定
-- （自动解绑只在老用户自己重新授权时触发），前住户继续看得到现住户的账单。
--
-- 此表成为绑定房屋的主数据源：加号 = 授权，删号 = 立即解绑（应用层同事务处理）。
-- ownerPhone/ownerName 列冻结不删：先回填，写路径在应用层移除，
-- 物理删列等真实数据导入验证后另行迁移 —— 加列删列分开，回滚才有路。

-- CreateTable
CREATE TABLE `HouseContact` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `houseId` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'ADMIN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HouseContact_tenantId_idx`(`tenantId`),
    INDEX `HouseContact_phone_idx`(`phone`),
    UNIQUE INDEX `HouseContact_houseId_phone_key`(`houseId`, `phone`),
    UNIQUE INDEX `HouseContact_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `HouseContact`
    ADD CONSTRAINT `HouseContact_tenantId_houseId_fkey`
      FOREIGN KEY (`tenantId`, `houseId`) REFERENCES `House`(`tenantId`, `id`)
      ON DELETE RESTRICT ON UPDATE CASCADE;

-- 回填：既有 ownerPhone → 联系人（source=BACKFILL）。
-- 确定性 id（hc_ + 房屋 id）+ NOT EXISTS 双保险 → 重跑幂等。
INSERT INTO `HouseContact` (`id`, `tenantId`, `houseId`, `phone`, `name`, `source`, `createdAt`)
SELECT CONCAT('hc_', h.`id`), h.`tenantId`, h.`id`, h.`ownerPhone`, h.`ownerName`, 'BACKFILL', NOW(3)
FROM `House` h
WHERE h.`ownerPhone` IS NOT NULL AND h.`ownerPhone` <> ''
  AND NOT EXISTS (
    SELECT 1 FROM `HouseContact` c WHERE c.`houseId` = h.`id` AND c.`phone` = h.`ownerPhone`
  );
