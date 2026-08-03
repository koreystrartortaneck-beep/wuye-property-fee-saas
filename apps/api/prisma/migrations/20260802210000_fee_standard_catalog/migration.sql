-- M1 · 收费标准目录 + 房屋挂接 + 放户日期
--
-- 起因：FeeRule 按「小区 + 房屋类型」自动全选房屋，而真实数据里每条例外
-- （2 期 4 号楼门市 1.2 元、商场包租固定 15000/年、若干免收）都落在这个粒度之外。
-- 改为「房屋显式挂接标准」：挂了才出账，不挂 = 不出账；调价改标准一条、挂着的全变。
--
-- 同时补上「按户周年」账期的地基：物业按放户日期收费（3/15 放户 →
-- 账期 2026-03-15 ~ 2027-03-14），全小区没有统一出账日 —— House 需要 handoverDate。
--
-- 全部为增量操作（加枚举值 / 加可空列 / 建新表），MySQL 8 在线安全；
-- periodScheme 按旧 period 回填，legacy 行为逐字节不变。

-- AlterTable: FeeRule 扩展为「收费标准」
ALTER TABLE `FeeRule`
    ADD COLUMN `code` VARCHAR(191) NULL,
    ADD COLUMN `periodScheme` ENUM('MONTHLY', 'QUARTERLY', 'YEARLY', 'ANNIVERSARY') NOT NULL DEFAULT 'MONTHLY',
    ADD COLUMN `rounding` ENUM('CENT', 'YUAN') NOT NULL DEFAULT 'CENT';

-- 回填：periodScheme = 旧 period（取值字符串一一对应），legacy 规则行为不变。
-- 必须 CAST 成字符串：ENUM 到 ENUM 直接赋值在 MySQL 里可能按索引数字解释 ——
-- 这里两个枚举前三个值顺序恰好相同、错也错不出来，但正确性不能靠巧合。
UPDATE `FeeRule` SET `periodScheme` = CAST(`period` AS CHAR);

-- 跨小区“同一条标准”靠 code 对齐（复制目录时按 code 去重）。
-- MySQL 唯一索引允许多个 NULL，legacy 无 code 的行不受影响。
CREATE UNIQUE INDEX `FeeRule_communityId_code_key` ON `FeeRule`(`communityId`, `code`);

-- AlterTable: House 加放户日期（可空；缺失时周年出账报 HANDOVER_DATE_MISSING 跳过）
ALTER TABLE `House` ADD COLUMN `handoverDate` DATE NULL;

-- CreateTable: 房屋 ↔ 收费标准挂接（ANNIVERSARY 方案的唯一选房依据）
CREATE TABLE `HouseStandard` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `houseId` VARCHAR(191) NOT NULL,
    `ruleId` VARCHAR(191) NOT NULL,
    `startDate` DATE NULL,
    `endDate` DATE NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HouseStandard_tenantId_idx`(`tenantId`),
    INDEX `HouseStandard_ruleId_status_idx`(`ruleId`, `status`),
    INDEX `HouseStandard_tenantId_houseId_idx`(`tenantId`, `houseId`),
    UNIQUE INDEX `HouseStandard_houseId_ruleId_key`(`houseId`, `ruleId`),
    UNIQUE INDEX `HouseStandard_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 复合外键（含 tenantId）：挂接只能指向同租户的房屋与标准，跨租户挂接在库层就不可能
ALTER TABLE `HouseStandard`
    ADD CONSTRAINT `HouseStandard_tenantId_houseId_fkey`
      FOREIGN KEY (`tenantId`, `houseId`) REFERENCES `House`(`tenantId`, `id`)
      ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `HouseStandard_tenantId_ruleId_fkey`
      FOREIGN KEY (`tenantId`, `ruleId`) REFERENCES `FeeRule`(`tenantId`, `id`)
      ON DELETE RESTRICT ON UPDATE CASCADE;
