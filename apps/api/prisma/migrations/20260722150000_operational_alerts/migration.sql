-- CreateTable
CREATE TABLE `OperationalAlert` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `alertType` VARCHAR(191) NOT NULL,
    `severity` ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'WARNING',
    `dedupKey` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `summary` TEXT NULL,
    `context` JSON NULL,
    `status` ENUM('OPEN', 'DELIVERED', 'FAILED') NOT NULL DEFAULT 'OPEN',
    `occurrences` INTEGER NOT NULL DEFAULT 1,
    `incidentId` VARCHAR(191) NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OperationalAlert_tenantId_idx`(`tenantId`),
    INDEX `OperationalAlert_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `OperationalAlert_tenantId_severity_idx`(`tenantId`, `severity`),
    INDEX `OperationalAlert_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `OperationalAlert_tenantId_incidentId_idx`(`tenantId`, `incidentId`),
    UNIQUE INDEX `OperationalAlert_tenantId_dedupKey_key`(`tenantId`, `dedupKey`),
    UNIQUE INDEX `OperationalAlert_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AlertAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `alertId` VARCHAR(191) NOT NULL,
    `attemptNo` INTEGER NOT NULL,
    `channel` VARCHAR(191) NOT NULL DEFAULT 'WEBHOOK',
    `success` BOOLEAN NOT NULL DEFAULT false,
    `statusCode` INTEGER NULL,
    `error` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AlertAttempt_tenantId_idx`(`tenantId`),
    INDEX `AlertAttempt_tenantId_alertId_idx`(`tenantId`, `alertId`),
    UNIQUE INDEX `AlertAttempt_tenantId_alertId_attemptNo_key`(`tenantId`, `alertId`, `attemptNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Incident` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `dedupKey` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `severity` ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'CRITICAL',
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `occurrences` INTEGER NOT NULL DEFAULT 1,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acknowledgedAt` DATETIME(3) NULL,
    `acknowledgedBy` VARCHAR(191) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedBy` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Incident_tenantId_idx`(`tenantId`),
    INDEX `Incident_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `Incident_tenantId_communityId_idx`(`tenantId`, `communityId`),
    UNIQUE INDEX `Incident_tenantId_dedupKey_key`(`tenantId`, `dedupKey`),
    UNIQUE INDEX `Incident_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OperationalAlert` ADD CONSTRAINT `OperationalAlert_tenantId_incidentId_fkey` FOREIGN KEY (`tenantId`, `incidentId`) REFERENCES `Incident`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AlertAttempt` ADD CONSTRAINT `AlertAttempt_tenantId_alertId_fkey` FOREIGN KEY (`tenantId`, `alertId`) REFERENCES `OperationalAlert`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
