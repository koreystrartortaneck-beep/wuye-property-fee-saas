-- M3 · 绑定渠道开关（租户级）
--
-- 手机号自动匹配 / 自助申请 / 申请是否需审批，三个开关做成配置，
-- 迁移到新楼盘时按需启停，不改代码。形状抄 TenantCollectionPolicy 先例：
-- 一租户一行，缺行 = 全默认（渠道全开、需审批）—— 懒解析，存量租户零回填。

-- CreateTable
CREATE TABLE `TenantBindingConfig` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `phoneMatch` BOOLEAN NOT NULL DEFAULT true,
    `selfApply` BOOLEAN NOT NULL DEFAULT true,
    `selfApplyNeedsApproval` BOOLEAN NOT NULL DEFAULT true,
    `changedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TenantBindingConfig_tenantId_key`(`tenantId`),
    UNIQUE INDEX `TenantBindingConfig_tenantId_id_key`(`tenantId`, `id`),
    INDEX `TenantBindingConfig_tenantId_changedBy_idx`(`tenantId`, `changedBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TenantBindingConfig`
    ADD CONSTRAINT `TenantBindingConfig_tenantId_fkey`
      FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
      ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `TenantBindingConfig_tenantId_changedBy_fkey`
      FOREIGN KEY (`tenantId`, `changedBy`) REFERENCES `AdminUser`(`tenantId`, `id`)
      ON DELETE RESTRICT ON UPDATE RESTRICT;
