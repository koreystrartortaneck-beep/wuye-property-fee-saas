-- CreateTable
CREATE TABLE `Tenant` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `contactName` VARCHAR(191) NULL,
    `contactPhone` VARCHAR(191) NULL,
    `subMchId` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Tenant_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminUser` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NULL,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `role` ENUM('SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF') NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AdminUser_username_key`(`username`),
    INDEX `AdminUser_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Community` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `address` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Community_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `House` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `type` ENUM('RESIDENCE', 'PARKING', 'SHOP') NOT NULL DEFAULT 'RESIDENCE',
    `building` VARCHAR(191) NULL,
    `unit` VARCHAR(191) NULL,
    `room` VARCHAR(191) NULL,
    `code` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `area` DECIMAL(10, 2) NULL,
    `ownerName` VARCHAR(191) NULL,
    `ownerPhone` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `House_tenantId_idx`(`tenantId`),
    INDEX `House_ownerPhone_idx`(`ownerPhone`),
    UNIQUE INDEX `House_communityId_code_key`(`communityId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WxUser` (
    `id` VARCHAR(191) NOT NULL,
    `openid` VARCHAR(191) NOT NULL,
    `unionid` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `nickname` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WxUser_openid_key`(`openid`),
    INDEX `WxUser_phone_idx`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HouseBinding` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `wxUserId` VARCHAR(191) NOT NULL,
    `houseId` VARCHAR(191) NOT NULL,
    `relation` ENUM('OWNER', 'FAMILY', 'TENANT') NOT NULL DEFAULT 'OWNER',
    `status` ENUM('PENDING', 'ACTIVE', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `source` ENUM('PHONE_MATCH', 'APPLY') NOT NULL,
    `applicantName` VARCHAR(191) NULL,
    `reviewedBy` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `rejectReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HouseBinding_tenantId_idx`(`tenantId`),
    INDEX `HouseBinding_houseId_idx`(`houseId`),
    UNIQUE INDEX `HouseBinding_wxUserId_houseId_key`(`wxUserId`, `houseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeeRule` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `houseType` ENUM('RESIDENCE', 'PARKING', 'SHOP') NOT NULL DEFAULT 'RESIDENCE',
    `ruleType` ENUM('AREA_PRICE', 'FIXED', 'METER', 'SHARE', 'FORMULA') NOT NULL,
    `params` JSON NOT NULL,
    `period` ENUM('MONTHLY', 'QUARTERLY', 'YEARLY') NOT NULL DEFAULT 'MONTHLY',
    `billDay` INTEGER NOT NULL DEFAULT 1,
    `dueDays` INTEGER NOT NULL DEFAULT 15,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FeeRule_tenantId_idx`(`tenantId`),
    INDEX `FeeRule_communityId_idx`(`communityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MeterReading` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `houseId` VARCHAR(191) NOT NULL,
    `meterType` ENUM('WATER', 'ELEC', 'GAS') NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `value` DECIMAL(12, 2) NOT NULL,
    `prevValue` DECIMAL(12, 2) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MeterReading_tenantId_idx`(`tenantId`),
    UNIQUE INDEX `MeterReading_houseId_meterType_period_key`(`houseId`, `meterType`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SharePool` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `ruleId` VARCHAR(191) NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `totalAmount` DECIMAL(12, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SharePool_tenantId_idx`(`tenantId`),
    UNIQUE INDEX `SharePool_ruleId_period_key`(`ruleId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillRun` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `ruleId` VARCHAR(191) NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `total` INTEGER NOT NULL DEFAULT 0,
    `generated` INTEGER NOT NULL DEFAULT 0,
    `skipped` INTEGER NOT NULL DEFAULT 0,
    `skippedDetail` JSON NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `BillRun_tenantId_idx`(`tenantId`),
    UNIQUE INDEX `BillRun_ruleId_period_key`(`ruleId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Bill` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `houseId` VARCHAR(191) NOT NULL,
    `ruleId` VARCHAR(191) NOT NULL,
    `billRunId` VARCHAR(191) NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `snapshot` JSON NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('UNPAID', 'PAID', 'CANCELED') NOT NULL DEFAULT 'UNPAID',
    `dueDate` DATETIME(3) NOT NULL,
    `paidAt` DATETIME(3) NULL,
    `paymentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Bill_tenantId_idx`(`tenantId`),
    INDEX `Bill_houseId_status_idx`(`houseId`, `status`),
    INDEX `Bill_status_dueDate_idx`(`status`, `dueDate`),
    UNIQUE INDEX `Bill_ruleId_houseId_period_key`(`ruleId`, `houseId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `wxUserId` VARCHAR(191) NOT NULL,
    `orderNo` VARCHAR(191) NOT NULL,
    `totalAmount` DECIMAL(12, 2) NOT NULL,
    `channel` ENUM('MOCK', 'WXPAY') NOT NULL DEFAULT 'MOCK',
    `status` ENUM('CREATED', 'SUCCESS', 'FAILED', 'CLOSED', 'REFUNDED') NOT NULL DEFAULT 'CREATED',
    `transactionId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Payment_orderNo_key`(`orderNo`),
    INDEX `Payment_tenantId_idx`(`tenantId`),
    INDEX `Payment_wxUserId_idx`(`wxUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentBill` (
    `paymentId` VARCHAR(191) NOT NULL,
    `billId` VARCHAR(191) NOT NULL,

    INDEX `PaymentBill_billId_idx`(`billId`),
    PRIMARY KEY (`paymentId`, `billId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotifyLog` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `wxUserId` VARCHAR(191) NULL,
    `billId` VARCHAR(191) NULL,
    `type` ENUM('BILL_CREATED', 'DUE_SOON', 'OVERDUE') NOT NULL,
    `channel` VARCHAR(191) NOT NULL DEFAULT 'MOCK',
    `status` ENUM('SENT', 'FAILED', 'SKIPPED') NOT NULL,
    `error` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `NotifyLog_tenantId_idx`(`tenantId`),
    INDEX `NotifyLog_billId_type_status_idx`(`billId`, `type`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AdminUser` ADD CONSTRAINT `AdminUser_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Community` ADD CONSTRAINT `Community_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `House` ADD CONSTRAINT `House_communityId_fkey` FOREIGN KEY (`communityId`) REFERENCES `Community`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HouseBinding` ADD CONSTRAINT `HouseBinding_wxUserId_fkey` FOREIGN KEY (`wxUserId`) REFERENCES `WxUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HouseBinding` ADD CONSTRAINT `HouseBinding_houseId_fkey` FOREIGN KEY (`houseId`) REFERENCES `House`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillRun` ADD CONSTRAINT `BillRun_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `FeeRule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_houseId_fkey` FOREIGN KEY (`houseId`) REFERENCES `House`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `FeeRule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_billRunId_fkey` FOREIGN KEY (`billRunId`) REFERENCES `BillRun`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_wxUserId_fkey` FOREIGN KEY (`wxUserId`) REFERENCES `WxUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentBill` ADD CONSTRAINT `PaymentBill_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentBill` ADD CONSTRAINT `PaymentBill_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
