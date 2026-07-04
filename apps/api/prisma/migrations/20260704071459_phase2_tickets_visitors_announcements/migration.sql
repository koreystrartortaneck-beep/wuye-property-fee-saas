-- AlterTable
ALTER TABLE `Community` ADD COLUMN `servicePhone` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Ticket` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `houseId` VARCHAR(191) NOT NULL,
    `wxUserId` VARCHAR(191) NOT NULL,
    `type` ENUM('REPAIR', 'COMPLAINT', 'SUGGESTION') NOT NULL,
    `content` TEXT NOT NULL,
    `images` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'DONE', 'CLOSED') NOT NULL DEFAULT 'PENDING',
    `assigneeName` VARCHAR(191) NULL,
    `replyContent` TEXT NULL,
    `processedAt` DATETIME(3) NULL,
    `doneAt` DATETIME(3) NULL,
    `rating` INTEGER NULL,
    `ratingComment` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Ticket_tenantId_idx`(`tenantId`),
    INDEX `Ticket_houseId_idx`(`houseId`),
    INDEX `Ticket_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VisitorPass` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `houseId` VARCHAR(191) NOT NULL,
    `wxUserId` VARCHAR(191) NOT NULL,
    `visitorName` VARCHAR(191) NOT NULL,
    `visitorPhone` VARCHAR(191) NULL,
    `plateNo` VARCHAR(191) NULL,
    `visitDate` DATETIME(3) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'USED', 'EXPIRED', 'CANCELED') NOT NULL DEFAULT 'ACTIVE',
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VisitorPass_tenantId_idx`(`tenantId`),
    INDEX `VisitorPass_visitDate_idx`(`visitDate`),
    UNIQUE INDEX `VisitorPass_tenantId_code_key`(`tenantId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Announcement` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `pinned` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('PUBLISHED', 'REVOKED') NOT NULL DEFAULT 'PUBLISHED',
    `createdBy` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Announcement_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Ticket` ADD CONSTRAINT `Ticket_houseId_fkey` FOREIGN KEY (`houseId`) REFERENCES `House`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Ticket` ADD CONSTRAINT `Ticket_wxUserId_fkey` FOREIGN KEY (`wxUserId`) REFERENCES `WxUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VisitorPass` ADD CONSTRAINT `VisitorPass_houseId_fkey` FOREIGN KEY (`houseId`) REFERENCES `House`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
