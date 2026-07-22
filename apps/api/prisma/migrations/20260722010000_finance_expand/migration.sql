-- AlterTable
ALTER TABLE `Bill` ADD COLUMN `batchId` VARCHAR(191) NULL,
    ADD COLUMN `publishedAt` DATETIME(3) NULL,
    ADD COLUMN `publishedBy` VARCHAR(191) NULL,
    ADD COLUMN `replacesBillId` VARCHAR(191) NULL,
    ADD COLUMN `source` ENUM('BILL_RUN', 'MANUAL', 'IMPORT', 'ADJUSTMENT') NOT NULL DEFAULT 'BILL_RUN',
    ADD COLUMN `voidReason` VARCHAR(191) NULL,
    ADD COLUMN `voidedAt` DATETIME(3) NULL,
    ADD COLUMN `voidedBy` VARCHAR(191) NULL,
    MODIFY `status` ENUM('UNPAID', 'PAID', 'CANCELED', 'DRAFT', 'REFUNDING', 'REFUNDED') NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE `Payment` ADD COLUMN `billId` VARCHAR(191) NULL,
    ADD COLUMN `communityId` VARCHAR(191) NULL,
    ADD COLUMN `confirmedAt` DATETIME(3) NULL,
    ADD COLUMN `confirmedBy` VARCHAR(191) NULL,
    ADD COLUMN `merchantSnapshot` JSON NULL,
    ADD COLUMN `offlineSnapshot` JSON NULL,
    ADD COLUMN `receiptSnapshot` JSON NULL,
    ADD COLUMN `recoveredAt` DATETIME(3) NULL,
    ADD COLUMN `recoveredBy` VARCHAR(191) NULL,
    ADD COLUMN `recoveryReason` VARCHAR(191) NULL,
    ADD COLUMN `recoverySnapshot` JSON NULL,
    ADD COLUMN `wxpayNotifiedAt` DATETIME(3) NULL,
    MODIFY `channel` ENUM('MOCK', 'WXPAY', 'OFFLINE') NOT NULL DEFAULT 'MOCK',
    MODIFY `status` ENUM('CREATED', 'SUCCESS', 'FAILED', 'CLOSED', 'REFUNDED', 'PREPAY_UNKNOWN') NOT NULL DEFAULT 'CREATED';

-- CreateTable
CREATE TABLE `BillBatch` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `batchNo` VARCHAR(191) NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NULL,
    `source` ENUM('BILL_RUN', 'MANUAL', 'IMPORT', 'ADJUSTMENT') NOT NULL DEFAULT 'BILL_RUN',
    `status` ENUM('DRAFT', 'GENERATING', 'READY', 'PUBLISHED', 'FAILED', 'CANCELED') NOT NULL DEFAULT 'DRAFT',
    `totalBills` INTEGER NOT NULL DEFAULT 0,
    `totalAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `createdBy` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `publishedBy` VARCHAR(191) NULL,
    `canceledAt` DATETIME(3) NULL,
    `canceledBy` VARCHAR(191) NULL,
    `cancelReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `BillBatch_tenantId_idx`(`tenantId`),
    INDEX `BillBatch_communityId_status_idx`(`communityId`, `status`),
    INDEX `BillBatch_period_idx`(`period`),
    UNIQUE INDEX `BillBatch_tenantId_batchNo_key`(`tenantId`, `batchNo`),
    UNIQUE INDEX `BillBatch_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Refund` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `billId` VARCHAR(191) NULL,
    `refundNo` VARCHAR(191) NOT NULL,
    `type` ENUM('FULL', 'PARTIAL') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `channel` ENUM('MOCK', 'WXPAY', 'OFFLINE') NOT NULL,
    `status` ENUM('CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'CLOSED') NOT NULL DEFAULT 'CREATED',
    `channelRefundId` VARCHAR(191) NULL,
    `requestedBy` VARCHAR(191) NULL,
    `approvedBy` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `refundedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `failureCode` VARCHAR(191) NULL,
    `failureMessage` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Refund_refundNo_key`(`refundNo`),
    INDEX `Refund_tenantId_idx`(`tenantId`),
    INDEX `Refund_communityId_idx`(`communityId`),
    INDEX `Refund_paymentId_status_idx`(`paymentId`, `status`),
    INDEX `Refund_billId_idx`(`billId`),
    INDEX `Refund_channelRefundId_idx`(`channelRefundId`),
    UNIQUE INDEX `Refund_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefundAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `refundId` VARCHAR(191) NOT NULL,
    `attemptNo` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `requestSnapshot` JSON NULL,
    `responseSnapshot` JSON NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RefundAttempt_tenantId_idx`(`tenantId`),
    INDEX `RefundAttempt_communityId_idx`(`communityId`),
    INDEX `RefundAttempt_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `RefundAttempt_refundId_attemptNo_key`(`refundId`, `attemptNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReconciliationRun` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `runNo` VARCHAR(191) NOT NULL,
    `channel` ENUM('MOCK', 'WXPAY', 'OFFLINE') NOT NULL,
    `businessDate` DATE NOT NULL,
    `status` ENUM('RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `totalItems` INTEGER NOT NULL DEFAULT 0,
    `matchedItems` INTEGER NOT NULL DEFAULT 0,
    `mismatchedItems` INTEGER NOT NULL DEFAULT 0,
    `localTotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `channelTotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `differenceTotal` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `sourceSnapshot` JSON NULL,
    `errorMessage` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReconciliationRun_runNo_key`(`runNo`),
    INDEX `ReconciliationRun_tenantId_idx`(`tenantId`),
    INDEX `ReconciliationRun_communityId_idx`(`communityId`),
    INDEX `ReconciliationRun_channel_businessDate_idx`(`channel`, `businessDate`),
    INDEX `ReconciliationRun_status_startedAt_idx`(`status`, `startedAt`),
    UNIQUE INDEX `ReconciliationRun_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReconciliationItem` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `runId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NULL,
    `refundId` VARCHAR(191) NULL,
    `type` ENUM('PAYMENT', 'REFUND') NOT NULL,
    `referenceNo` VARCHAR(191) NOT NULL,
    `status` ENUM('MATCHED', 'AMOUNT_MISMATCH', 'LOCAL_MISSING', 'CHANNEL_MISSING', 'IGNORED') NOT NULL,
    `localAmount` DECIMAL(12, 2) NULL,
    `channelAmount` DECIMAL(12, 2) NULL,
    `differenceAmount` DECIMAL(12, 2) NULL,
    `channelTradeNo` VARCHAR(191) NULL,
    `detail` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReconciliationItem_tenantId_idx`(`tenantId`),
    INDEX `ReconciliationItem_communityId_idx`(`communityId`),
    INDEX `ReconciliationItem_paymentId_idx`(`paymentId`),
    INDEX `ReconciliationItem_refundId_idx`(`refundId`),
    INDEX `ReconciliationItem_status_idx`(`status`),
    UNIQUE INDEX `ReconciliationItem_runId_type_referenceNo_key`(`runId`, `type`, `referenceNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'WX_USER') NOT NULL DEFAULT 'SYSTEM',
    `actorId` VARCHAR(191) NULL,
    `action` ENUM('CREATE', 'UPDATE', 'PUBLISH', 'VOID', 'PAY', 'REFUND', 'RECONCILE', 'INVOICE', 'RECOVER') NOT NULL,
    `resourceType` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `beforeData` JSON NULL,
    `afterData` JSON NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    INDEX `AuditLog_communityId_createdAt_idx`(`communityId`, `createdAt`),
    INDEX `AuditLog_resourceType_resourceId_idx`(`resourceType`, `resourceId`),
    INDEX `AuditLog_actorId_createdAt_idx`(`actorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `eventKey` VARCHAR(191) NOT NULL,
    `type` ENUM('CREATED', 'CHANNEL_ORDER_CREATED', 'NOTIFIED', 'CONFIRMED', 'CLOSED', 'FAILED', 'REFUNDING', 'REFUNDED', 'RECOVERED') NOT NULL,
    `source` VARCHAR(191) NULL,
    `payload` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaymentEvent_tenantId_idx`(`tenantId`),
    INDEX `PaymentEvent_communityId_idx`(`communityId`),
    INDEX `PaymentEvent_paymentId_occurredAt_idx`(`paymentId`, `occurredAt`),
    INDEX `PaymentEvent_type_occurredAt_idx`(`type`, `occurredAt`),
    UNIQUE INDEX `PaymentEvent_paymentId_eventKey_key`(`paymentId`, `eventKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IdempotencyRecord` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `scope` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `status` ENUM('PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PROCESSING',
    `requestHash` VARCHAR(191) NOT NULL,
    `responseCode` INTEGER NULL,
    `responseBody` JSON NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `lockedUntil` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IdempotencyRecord_tenantId_idx`(`tenantId`),
    INDEX `IdempotencyRecord_communityId_idx`(`communityId`),
    INDEX `IdempotencyRecord_status_lockedUntil_idx`(`status`, `lockedUntil`),
    INDEX `IdempotencyRecord_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `IdempotencyRecord_tenantId_scope_key_key`(`tenantId`, `scope`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxEvent` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `aggregateType` VARCHAR(191) NOT NULL,
    `aggregateId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `dedupKey` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockedAt` DATETIME(3) NULL,
    `lockedBy` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `lastError` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OutboxEvent_tenantId_status_availableAt_idx`(`tenantId`, `status`, `availableAt`),
    INDEX `OutboxEvent_communityId_idx`(`communityId`),
    INDEX `OutboxEvent_aggregateType_aggregateId_idx`(`aggregateType`, `aggregateId`),
    UNIQUE INDEX `OutboxEvent_tenantId_dedupKey_key`(`tenantId`, `dedupKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InvoiceApplication` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NULL,
    `wxUserId` VARCHAR(191) NULL,
    `applicationNo` VARCHAR(191) NOT NULL,
    `titleType` ENUM('PERSONAL', 'ENTERPRISE') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `taxNo` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('SUBMITTED', 'PROCESSING', 'ISSUED', 'REJECTED', 'CANCELED') NOT NULL DEFAULT 'SUBMITTED',
    `invoiceNo` VARCHAR(191) NULL,
    `invoiceUrl` VARCHAR(191) NULL,
    `requestedBy` VARCHAR(191) NULL,
    `processedBy` VARCHAR(191) NULL,
    `appliedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `issuedAt` DATETIME(3) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `InvoiceApplication_applicationNo_key`(`applicationNo`),
    INDEX `InvoiceApplication_tenantId_idx`(`tenantId`),
    INDEX `InvoiceApplication_communityId_idx`(`communityId`),
    INDEX `InvoiceApplication_paymentId_idx`(`paymentId`),
    INDEX `InvoiceApplication_wxUserId_idx`(`wxUserId`),
    INDEX `InvoiceApplication_status_appliedAt_idx`(`status`, `appliedAt`),
    INDEX `InvoiceApplication_invoiceNo_idx`(`invoiceNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformCollectionPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `mode` ENUM('PLATFORM', 'TENANT', 'COMMUNITY') NOT NULL DEFAULT 'PLATFORM',
    `merchantSnapshot` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PlatformCollectionPolicy_code_key`(`code`),
    INDEX `PlatformCollectionPolicy_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TenantCollectionPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `platformPolicyId` VARCHAR(191) NULL,
    `mode` ENUM('PLATFORM', 'TENANT', 'COMMUNITY') NOT NULL DEFAULT 'TENANT',
    `merchantSnapshot` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TenantCollectionPolicy_tenantId_key`(`tenantId`),
    INDEX `TenantCollectionPolicy_platformPolicyId_idx`(`platformPolicyId`),
    INDEX `TenantCollectionPolicy_tenantId_enabled_idx`(`tenantId`, `enabled`),
    UNIQUE INDEX `TenantCollectionPolicy_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CommunityCollectionPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `tenantPolicyId` VARCHAR(191) NULL,
    `mode` ENUM('PLATFORM', 'TENANT', 'COMMUNITY') NOT NULL DEFAULT 'COMMUNITY',
    `merchantSnapshot` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CommunityCollectionPolicy_tenantId_enabled_idx`(`tenantId`, `enabled`),
    INDEX `CommunityCollectionPolicy_tenantPolicyId_idx`(`tenantPolicyId`),
    UNIQUE INDEX `CommunityCollectionPolicy_tenantId_communityId_key`(`tenantId`, `communityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Community_tenantId_id_key` ON `Community`(`tenantId`, `id`);

-- CreateIndex
CREATE INDEX `Bill_batchId_idx` ON `Bill`(`batchId`);

-- CreateIndex
CREATE UNIQUE INDEX `Bill_tenantId_id_key` ON `Bill`(`tenantId`, `id`);

-- CreateIndex
CREATE INDEX `Payment_billId_idx` ON `Payment`(`billId`);

-- CreateIndex
CREATE INDEX `Payment_communityId_status_idx` ON `Payment`(`communityId`, `status`);

-- CreateIndex
CREATE INDEX `Payment_transactionId_idx` ON `Payment`(`transactionId`);

-- CreateIndex
CREATE UNIQUE INDEX `Payment_tenantId_id_key` ON `Payment`(`tenantId`, `id`);

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_batchId_fkey` FOREIGN KEY (`tenantId`, `batchId`) REFERENCES `BillBatch`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_replacesBillId_fkey` FOREIGN KEY (`tenantId`, `replacesBillId`) REFERENCES `Bill`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_tenantId_billId_fkey` FOREIGN KEY (`tenantId`, `billId`) REFERENCES `Bill`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillBatch` ADD CONSTRAINT `BillBatch_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_tenantId_billId_fkey` FOREIGN KEY (`tenantId`, `billId`) REFERENCES `Bill`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefundAttempt` ADD CONSTRAINT `RefundAttempt_tenantId_refundId_fkey` FOREIGN KEY (`tenantId`, `refundId`) REFERENCES `Refund`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_runId_fkey` FOREIGN KEY (`tenantId`, `runId`) REFERENCES `ReconciliationRun`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_refundId_fkey` FOREIGN KEY (`tenantId`, `refundId`) REFERENCES `Refund`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentEvent` ADD CONSTRAINT `PaymentEvent_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InvoiceApplication` ADD CONSTRAINT `InvoiceApplication_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TenantCollectionPolicy` ADD CONSTRAINT `TenantCollectionPolicy_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TenantCollectionPolicy` ADD CONSTRAINT `TenantCollectionPolicy_platformPolicyId_fkey` FOREIGN KEY (`platformPolicyId`) REFERENCES `PlatformCollectionPolicy`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CommunityCollectionPolicy` ADD CONSTRAINT `CommunityCollectionPolicy_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CommunityCollectionPolicy` ADD CONSTRAINT `CommunityCollectionPolicy_tenantId_tenantPolicyId_fkey` FOREIGN KEY (`tenantId`, `tenantPolicyId`) REFERENCES `TenantCollectionPolicy`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
