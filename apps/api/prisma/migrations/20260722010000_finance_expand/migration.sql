-- Existing tables: additive columns, enum expansion, and nullable loosening only.
ALTER TABLE `FeeRule` ADD COLUMN `category` VARCHAR(191) NULL;

ALTER TABLE `Bill` ADD COLUMN `batchId` VARCHAR(191) NULL,
    ADD COLUMN `cancelReason` VARCHAR(191) NULL,
    ADD COLUMN `canceledAt` DATETIME(3) NULL,
    ADD COLUMN `canceledBy` VARCHAR(191) NULL,
    ADD COLUMN `publishedAt` DATETIME(3) NULL,
    ADD COLUMN `publishedBy` VARCHAR(191) NULL,
    ADD COLUMN `replacesBillId` VARCHAR(191) NULL,
    ADD COLUMN `source` ENUM('RULE', 'IMPORT') NULL,
    ADD COLUMN `sourceRowKey` VARCHAR(191) NULL,
    MODIFY `ruleId` VARCHAR(191) NULL,
    MODIFY `billRunId` VARCHAR(191) NULL,
    MODIFY `status` ENUM('UNPAID', 'PAID', 'CANCELED', 'DRAFT', 'REFUNDING', 'REFUNDED') NOT NULL DEFAULT 'UNPAID';

ALTER TABLE `Payment` ADD COLUMN `appid` VARCHAR(191) NULL,
    ADD COLUMN `billId` VARCHAR(191) NULL,
    ADD COLUMN `closedAt` DATETIME(3) NULL,
    ADD COLUMN `communityId` VARCHAR(191) NULL,
    ADD COLUMN `confirmedAt` DATETIME(3) NULL,
    ADD COLUMN `confirmedBy` ENUM('WXPAY_NOTIFY', 'WXPAY_QUERY', 'OFFLINE', 'MOCK') NULL,
    ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `failureCode` VARCHAR(191) NULL,
    ADD COLUMN `failureMessage` VARCHAR(191) NULL,
    ADD COLUMN `lastSyncedAt` DATETIME(3) NULL,
    ADD COLUMN `mchid` VARCHAR(191) NULL,
    ADD COLUMN `merchantAccountId` VARCHAR(191) NULL,
    ADD COLUMN `offlineOperatorId` VARCHAR(191) NULL,
    ADD COLUMN `offlinePaidAt` DATETIME(3) NULL,
    ADD COLUMN `offlinePayerSnapshot` JSON NULL,
    ADD COLUMN `offlineRemark` VARCHAR(191) NULL,
    ADD COLUMN `offlineVoucherNo` VARCHAR(191) NULL,
    ADD COLUMN `receiptNo` VARCHAR(191) NULL,
    ADD COLUMN `receiptSnapshot` JSON NULL,
    ADD COLUMN `recoveredAt` DATETIME(3) NULL,
    ADD COLUMN `recoveredBy` VARCHAR(191) NULL,
    ADD COLUMN `recoveryReason` VARCHAR(191) NULL,
    ADD COLUMN `wxpayNotifiedAt` DATETIME(3) NULL,
    MODIFY `wxUserId` VARCHAR(191) NULL,
    MODIFY `channel` ENUM('MOCK', 'WXPAY', 'OFFLINE') NOT NULL DEFAULT 'MOCK',
    MODIFY `status` ENUM('CREATED', 'SUCCESS', 'FAILED', 'CLOSED', 'REFUNDED', 'PREPAY_UNKNOWN') NOT NULL DEFAULT 'CREATED';

-- Online writes keep requiring wxUserId in the existing payment service. MySQL cannot add a
-- CHECK over wxUserId while its legacy ON UPDATE CASCADE foreign key remains in this expansion.
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_offline_fields_chk` CHECK (
    `channel` <> 'OFFLINE'
    OR (
      `offlineVoucherNo` IS NOT NULL
      AND `offlinePaidAt` IS NOT NULL
      AND `offlineOperatorId` IS NOT NULL
      AND `offlinePayerSnapshot` IS NOT NULL
    )
);

CREATE TABLE `BillBatch` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `batchNo` VARCHAR(191) NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NULL,
    `source` ENUM('RULE', 'IMPORT') NOT NULL,
    `ruleId` VARCHAR(191) NULL,
    `importFileName` VARCHAR(191) NULL,
    `importFileHash` VARCHAR(191) NULL,
    `status` ENUM('DRAFT', 'GENERATING', 'READY', 'PUBLISHED', 'FAILED', 'CANCELED') NOT NULL DEFAULT 'DRAFT',
    `totalRows` INTEGER NOT NULL DEFAULT 0,
    `validRows` INTEGER NOT NULL DEFAULT 0,
    `invalidRows` INTEGER NOT NULL DEFAULT 0,
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
    INDEX `BillBatch_tenantId_ruleId_idx`(`tenantId`, `ruleId`),
    INDEX `BillBatch_tenantId_createdBy_idx`(`tenantId`, `createdBy`),
    INDEX `BillBatch_tenantId_publishedBy_idx`(`tenantId`, `publishedBy`),
    INDEX `BillBatch_tenantId_canceledBy_idx`(`tenantId`, `canceledBy`),
    INDEX `BillBatch_period_idx`(`period`),
    UNIQUE INDEX `BillBatch_tenantId_batchNo_key`(`tenantId`, `batchNo`),
    UNIQUE INDEX `BillBatch_tenantId_id_key`(`tenantId`, `id`),
    UNIQUE INDEX `BillBatch_tenantId_communityId_importFileHash_key`(`tenantId`, `communityId`, `importFileHash`),
    CONSTRAINT `BillBatch_source_fields_chk` CHECK (
      (`source` = 'RULE' AND `ruleId` IS NOT NULL AND `importFileName` IS NULL AND `importFileHash` IS NULL)
      OR
      (`source` = 'IMPORT' AND `ruleId` IS NULL AND `importFileName` IS NOT NULL AND `importFileHash` IS NOT NULL)
    ),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Refund` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `billId` VARCHAR(191) NULL,
    `merchantAccountId` VARCHAR(191) NOT NULL,
    `mchid` VARCHAR(191) NOT NULL,
    `appid` VARCHAR(191) NOT NULL,
    `refundNo` VARCHAR(191) NOT NULL,
    `providerRefundId` VARCHAR(191) NULL,
    `type` ENUM('FULL') NOT NULL,
    `originalAmount` DECIMAL(12, 2) NOT NULL,
    `refundAmount` DECIMAL(12, 2) NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'CNY',
    `reason` VARCHAR(191) NOT NULL,
    `channel` ENUM('MOCK', 'WXPAY', 'OFFLINE') NOT NULL,
    `status` ENUM('CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'CLOSED', 'ABNORMAL') NOT NULL DEFAULT 'CREATED',
    `requestedBy` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processingAt` DATETIME(3) NULL,
    `refundedAt` DATETIME(3) NULL,
    `notifyReceivedAt` DATETIME(3) NULL,
    `lastQueriedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `failureCode` VARCHAR(191) NULL,
    `failureMessage` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Refund_paymentId_key`(`paymentId`),
    UNIQUE INDEX `Refund_refundNo_key`(`refundNo`),
    UNIQUE INDEX `Refund_providerRefundId_key`(`providerRefundId`),
    INDEX `Refund_tenantId_idx`(`tenantId`),
    INDEX `Refund_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `Refund_tenantId_requestedBy_idx`(`tenantId`, `requestedBy`),
    INDEX `Refund_paymentId_status_idx`(`paymentId`, `status`),
    INDEX `Refund_billId_idx`(`billId`),
    UNIQUE INDEX `Refund_tenantId_id_key`(`tenantId`, `id`),
    UNIQUE INDEX `Refund_tenantId_paymentId_key`(`tenantId`, `paymentId`),
    CONSTRAINT `Refund_full_amount_chk` CHECK (
      `type` = 'FULL'
      AND `refundAmount` = `originalAmount`
    ),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RefundAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `refundId` VARCHAR(191) NOT NULL,
    `attemptNo` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `requestHash` VARCHAR(191) NOT NULL,
    `requestSummary` JSON NULL,
    `responseSummary` JSON NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `attemptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `RefundAttempt_tenantId_idx`(`tenantId`),
    INDEX `RefundAttempt_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `RefundAttempt_status_attemptedAt_idx`(`status`, `attemptedAt`),
    UNIQUE INDEX `RefundAttempt_tenantId_refundId_attemptNo_key`(`tenantId`, `refundId`, `attemptNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ReconciliationRun` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `runNo` VARCHAR(191) NOT NULL,
    `merchantAccountId` VARCHAR(191) NOT NULL,
    `mchid` VARCHAR(191) NOT NULL,
    `channel` ENUM('MOCK', 'WXPAY', 'OFFLINE') NOT NULL,
    `businessDate` DATE NOT NULL,
    `billType` ENUM('TRANSACTION', 'REFUND') NOT NULL,
    `channelFileHash` VARCHAR(191) NULL,
    `channelRecordCount` INTEGER NOT NULL DEFAULT 0,
    `channelAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `localRecordCount` INTEGER NOT NULL DEFAULT 0,
    `localAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `matchedRecordCount` INTEGER NOT NULL DEFAULT 0,
    `differenceRecordCount` INTEGER NOT NULL DEFAULT 0,
    `differenceAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `status` ENUM('RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `leaseOwner` VARCHAR(191) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReconciliationRun_runNo_key`(`runNo`),
    INDEX `ReconciliationRun_tenantId_idx`(`tenantId`),
    INDEX `ReconciliationRun_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `ReconciliationRun_status_leaseExpiresAt_idx`(`status`, `leaseExpiresAt`),
    INDEX `ReconciliationRun_status_startedAt_idx`(`status`, `startedAt`),
    INDEX `ReconciliationRun_tenantId_createdBy_idx`(`tenantId`, `createdBy`),
    UNIQUE INDEX `ReconciliationRun_tenantId_id_key`(`tenantId`, `id`),
    UNIQUE INDEX `ReconciliationRun_merchantAccountId_businessDate_billType_key`(`merchantAccountId`, `businessDate`, `billType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ReconciliationItem` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `runId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NULL,
    `refundId` VARCHAR(191) NULL,
    `orderNo` VARCHAR(191) NOT NULL,
    `differenceType` ENUM('CHANNEL_MISSING', 'LOCAL_MISSING', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'REFUND_MISMATCH') NOT NULL,
    `status` ENUM('OPEN', 'AUTO_RESOLVED', 'MANUALLY_CLOSED', 'ESCALATED') NOT NULL DEFAULT 'OPEN',
    `localAmount` DECIMAL(12, 2) NULL,
    `channelAmount` DECIMAL(12, 2) NULL,
    `differenceAmount` DECIMAL(12, 2) NULL,
    `localStatus` VARCHAR(191) NULL,
    `channelStatus` VARCHAR(191) NULL,
    `channelTransactionId` VARCHAR(191) NULL,
    `detailSummary` JSON NULL,
    `handledBy` VARCHAR(191) NULL,
    `handledAt` DATETIME(3) NULL,
    `handlingRemark` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReconciliationItem_tenantId_idx`(`tenantId`),
    INDEX `ReconciliationItem_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `ReconciliationItem_paymentId_idx`(`paymentId`),
    INDEX `ReconciliationItem_refundId_idx`(`refundId`),
    INDEX `ReconciliationItem_status_idx`(`status`),
    INDEX `ReconciliationItem_tenantId_handledBy_idx`(`tenantId`, `handledBy`),
    UNIQUE INDEX `ReconciliationItem_runId_orderNo_differenceType_key`(`runId`, `orderNo`, `differenceType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'WX_USER') NOT NULL DEFAULT 'SYSTEM',
    `actorId` VARCHAR(191) NULL,
    `action` ENUM('CREATE', 'UPDATE', 'PUBLISH', 'CANCEL', 'PAY', 'REFUND', 'RECONCILE', 'INVOICE', 'RECOVER') NOT NULL,
    `resourceType` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `requestId` VARCHAR(191) NULL,
    `ip` VARCHAR(191) NULL,
    `userAgent` VARCHAR(191) NULL,
    `beforeSummary` JSON NULL,
    `afterSummary` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    INDEX `AuditLog_tenantId_communityId_createdAt_idx`(`tenantId`, `communityId`, `createdAt`),
    INDEX `AuditLog_resourceType_resourceId_idx`(`resourceType`, `resourceId`),
    INDEX `AuditLog_requestId_idx`(`requestId`),
    INDEX `AuditLog_actorId_createdAt_idx`(`actorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PaymentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NULL,
    `refundId` VARCHAR(191) NULL,
    `eventKey` VARCHAR(191) NOT NULL,
    `type` ENUM('CREATED', 'CHANNEL_ORDER_CREATED', 'NOTIFIED', 'CONFIRMED', 'CLOSED', 'FAILED', 'REFUNDING', 'REFUNDED', 'RECOVERED') NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `source` VARCHAR(191) NULL,
    `payloadHash` VARCHAR(191) NULL,
    `summary` JSON NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `claimOwner` VARCHAR(191) NULL,
    `claimExpiresAt` DATETIME(3) NULL,
    `processedAt` DATETIME(3) NULL,
    `lastError` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaymentEvent_tenantId_idx`(`tenantId`),
    INDEX `PaymentEvent_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `PaymentEvent_paymentId_occurredAt_idx`(`paymentId`, `occurredAt`),
    INDEX `PaymentEvent_refundId_occurredAt_idx`(`refundId`, `occurredAt`),
    INDEX `PaymentEvent_status_availableAt_idx`(`status`, `availableAt`),
    INDEX `PaymentEvent_type_occurredAt_idx`(`type`, `occurredAt`),
    UNIQUE INDEX `PaymentEvent_tenantId_eventKey_key`(`tenantId`, `eventKey`),
    CONSTRAINT `PaymentEvent_target_chk` CHECK (
      (`paymentId` IS NOT NULL AND `refundId` IS NULL)
      OR
      (`paymentId` IS NULL AND `refundId` IS NOT NULL)
    ),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `IdempotencyRecord` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `actorKey` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `status` ENUM('PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PROCESSING',
    `requestHash` VARCHAR(191) NOT NULL,
    `responseCode` INTEGER NULL,
    `responseBody` JSON NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `claimOwner` VARCHAR(191) NULL,
    `claimExpiresAt` DATETIME(3) NULL,
    `nextRetryAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IdempotencyRecord_tenantId_idx`(`tenantId`),
    INDEX `IdempotencyRecord_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `IdempotencyRecord_status_claimExpiresAt_idx`(`status`, `claimExpiresAt`),
    INDEX `IdempotencyRecord_status_nextRetryAt_idx`(`status`, `nextRetryAt`),
    INDEX `IdempotencyRecord_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `IdempotencyRecord_tenantId_actorKey_action_requestId_key`(`tenantId`, `actorKey`, `action`, `requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OutboxEvent` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NULL,
    `aggregateType` VARCHAR(191) NOT NULL,
    `aggregateId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `dedupKey` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `claimOwner` VARCHAR(191) NULL,
    `claimExpiresAt` DATETIME(3) NULL,
    `lastAttemptAt` DATETIME(3) NULL,
    `publishedAt` DATETIME(3) NULL,
    `lastError` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OutboxEvent_tenantId_status_availableAt_idx`(`tenantId`, `status`, `availableAt`),
    INDEX `OutboxEvent_status_claimExpiresAt_idx`(`status`, `claimExpiresAt`),
    INDEX `OutboxEvent_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `OutboxEvent_aggregateType_aggregateId_idx`(`aggregateType`, `aggregateId`),
    UNIQUE INDEX `OutboxEvent_tenantId_dedupKey_key`(`tenantId`, `dedupKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `InvoiceApplication` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `wxUserId` VARCHAR(191) NOT NULL,
    `applicationNo` VARCHAR(191) NOT NULL,
    `titleType` ENUM('PERSONAL', 'ENTERPRISE') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `taxNo` VARCHAR(191) NULL,
    `deliveryMethod` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('SUBMITTED', 'PROCESSING', 'ISSUED', 'REJECTED', 'CANCELED', 'REVERSAL_REQUIRED', 'REVERSED') NOT NULL DEFAULT 'SUBMITTED',
    `invoiceNo` VARCHAR(191) NULL,
    `invoiceUrl` VARCHAR(191) NULL,
    `processedBy` VARCHAR(191) NULL,
    `appliedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `issuedAt` DATETIME(3) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectReason` VARCHAR(191) NULL,
    `reversalRequiredAt` DATETIME(3) NULL,
    `reversedAt` DATETIME(3) NULL,
    `reversalRemark` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `InvoiceApplication_applicationNo_key`(`applicationNo`),
    UNIQUE INDEX `InvoiceApplication_invoiceNo_key`(`invoiceNo`),
    INDEX `InvoiceApplication_tenantId_idx`(`tenantId`),
    INDEX `InvoiceApplication_tenantId_communityId_idx`(`tenantId`, `communityId`),
    INDEX `InvoiceApplication_wxUserId_idx`(`wxUserId`),
    INDEX `InvoiceApplication_status_appliedAt_idx`(`status`, `appliedAt`),
    INDEX `InvoiceApplication_tenantId_processedBy_idx`(`tenantId`, `processedBy`),
    UNIQUE INDEX `InvoiceApplication_tenantId_paymentId_key`(`tenantId`, `paymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlatformCollectionPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('OPEN', 'PAUSED') NOT NULL DEFAULT 'OPEN',
    `changedBy` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resumeAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PlatformCollectionPolicy_code_key`(`code`),
    INDEX `PlatformCollectionPolicy_changedBy_idx`(`changedBy`),
    INDEX `PlatformCollectionPolicy_status_resumeAt_idx`(`status`, `resumeAt`),
    CONSTRAINT `PlatformCollectionPolicy_pause_reason_chk` CHECK (
      `status` <> 'PAUSED'
      OR (`reason` IS NOT NULL AND `changedBy` IS NOT NULL)
    ),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TenantCollectionPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `platformPolicyId` VARCHAR(191) NULL,
    `status` ENUM('OPEN', 'PAUSED') NOT NULL DEFAULT 'OPEN',
    `changedBy` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resumeAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TenantCollectionPolicy_tenantId_key`(`tenantId`),
    INDEX `TenantCollectionPolicy_platformPolicyId_idx`(`platformPolicyId`),
    INDEX `TenantCollectionPolicy_tenantId_status_resumeAt_idx`(`tenantId`, `status`, `resumeAt`),
    INDEX `TenantCollectionPolicy_tenantId_changedBy_idx`(`tenantId`, `changedBy`),
    UNIQUE INDEX `TenantCollectionPolicy_tenantId_id_key`(`tenantId`, `id`),
    CONSTRAINT `TenantCollectionPolicy_pause_reason_chk` CHECK (
      `status` <> 'PAUSED'
      OR (`reason` IS NOT NULL AND `changedBy` IS NOT NULL)
    ),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CommunityCollectionPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `communityId` VARCHAR(191) NOT NULL,
    `tenantPolicyId` VARCHAR(191) NULL,
    `status` ENUM('OPEN', 'PAUSED') NOT NULL DEFAULT 'OPEN',
    `changedBy` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resumeAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CommunityCollectionPolicy_tenantId_status_resumeAt_idx`(`tenantId`, `status`, `resumeAt`),
    INDEX `CommunityCollectionPolicy_tenantPolicyId_idx`(`tenantPolicyId`),
    INDEX `CommunityCollectionPolicy_tenantId_changedBy_idx`(`tenantId`, `changedBy`),
    UNIQUE INDEX `CommunityCollectionPolicy_tenantId_communityId_key`(`tenantId`, `communityId`),
    CONSTRAINT `CommunityCollectionPolicy_pause_reason_chk` CHECK (
      `status` <> 'PAUSED'
      OR (`reason` IS NOT NULL AND `changedBy` IS NOT NULL)
    ),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Composite keys used by tenant-matching foreign keys. Existing keys remain intact.
CREATE UNIQUE INDEX `AdminUser_tenantId_id_key` ON `AdminUser`(`tenantId`, `id`);
CREATE UNIQUE INDEX `Community_tenantId_id_key` ON `Community`(`tenantId`, `id`);
CREATE UNIQUE INDEX `House_tenantId_id_key` ON `House`(`tenantId`, `id`);
CREATE INDEX `House_tenantId_communityId_idx` ON `House`(`tenantId`, `communityId`);
CREATE UNIQUE INDEX `FeeRule_tenantId_id_key` ON `FeeRule`(`tenantId`, `id`);
CREATE UNIQUE INDEX `BillRun_tenantId_id_key` ON `BillRun`(`tenantId`, `id`);

CREATE INDEX `Bill_tenantId_communityId_idx` ON `Bill`(`tenantId`, `communityId`);
CREATE INDEX `Bill_tenantId_publishedBy_idx` ON `Bill`(`tenantId`, `publishedBy`);
CREATE INDEX `Bill_tenantId_canceledBy_idx` ON `Bill`(`tenantId`, `canceledBy`);
CREATE INDEX `Bill_tenantId_replacesBillId_idx` ON `Bill`(`tenantId`, `replacesBillId`);
CREATE INDEX `Bill_batchId_idx` ON `Bill`(`batchId`);
CREATE UNIQUE INDEX `Bill_tenantId_id_key` ON `Bill`(`tenantId`, `id`);
CREATE UNIQUE INDEX `Bill_tenantId_batchId_sourceRowKey_key` ON `Bill`(`tenantId`, `batchId`, `sourceRowKey`);

CREATE UNIQUE INDEX `Payment_transactionId_key` ON `Payment`(`transactionId`);
CREATE UNIQUE INDEX `Payment_receiptNo_key` ON `Payment`(`receiptNo`);
CREATE UNIQUE INDEX `Payment_offlineVoucherNo_key` ON `Payment`(`offlineVoucherNo`);
CREATE INDEX `Payment_billId_idx` ON `Payment`(`billId`);
CREATE INDEX `Payment_communityId_status_idx` ON `Payment`(`communityId`, `status`);
CREATE INDEX `Payment_tenantId_offlineOperatorId_idx` ON `Payment`(`tenantId`, `offlineOperatorId`);
CREATE UNIQUE INDEX `Payment_tenantId_id_key` ON `Payment`(`tenantId`, `id`);

-- Tenant-matching foreign keys prevent cross-tenant finance associations.
ALTER TABLE `House` ADD CONSTRAINT `House_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `FeeRule` ADD CONSTRAINT `FeeRule_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `BillRun` ADD CONSTRAINT `BillRun_tenantId_ruleId_fkey` FOREIGN KEY (`tenantId`, `ruleId`) REFERENCES `FeeRule`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_houseId_fkey` FOREIGN KEY (`tenantId`, `houseId`) REFERENCES `House`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_ruleId_fkey` FOREIGN KEY (`tenantId`, `ruleId`) REFERENCES `FeeRule`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_billRunId_fkey` FOREIGN KEY (`tenantId`, `billRunId`) REFERENCES `BillRun`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_batchId_fkey` FOREIGN KEY (`tenantId`, `batchId`) REFERENCES `BillBatch`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_publishedBy_fkey` FOREIGN KEY (`tenantId`, `publishedBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_canceledBy_fkey` FOREIGN KEY (`tenantId`, `canceledBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_tenantId_replacesBillId_fkey` FOREIGN KEY (`tenantId`, `replacesBillId`) REFERENCES `Bill`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_tenantId_billId_fkey` FOREIGN KEY (`tenantId`, `billId`) REFERENCES `Bill`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_tenantId_offlineOperatorId_fkey` FOREIGN KEY (`tenantId`, `offlineOperatorId`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `BillBatch` ADD CONSTRAINT `BillBatch_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `BillBatch` ADD CONSTRAINT `BillBatch_tenantId_ruleId_fkey` FOREIGN KEY (`tenantId`, `ruleId`) REFERENCES `FeeRule`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `BillBatch` ADD CONSTRAINT `BillBatch_tenantId_createdBy_fkey` FOREIGN KEY (`tenantId`, `createdBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `BillBatch` ADD CONSTRAINT `BillBatch_tenantId_publishedBy_fkey` FOREIGN KEY (`tenantId`, `publishedBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `BillBatch` ADD CONSTRAINT `BillBatch_tenantId_canceledBy_fkey` FOREIGN KEY (`tenantId`, `canceledBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_tenantId_billId_fkey` FOREIGN KEY (`tenantId`, `billId`) REFERENCES `Bill`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_tenantId_requestedBy_fkey` FOREIGN KEY (`tenantId`, `requestedBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `RefundAttempt` ADD CONSTRAINT `RefundAttempt_tenantId_refundId_fkey` FOREIGN KEY (`tenantId`, `refundId`) REFERENCES `Refund`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `RefundAttempt` ADD CONSTRAINT `RefundAttempt_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ReconciliationRun` ADD CONSTRAINT `ReconciliationRun_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ReconciliationRun` ADD CONSTRAINT `ReconciliationRun_tenantId_createdBy_fkey` FOREIGN KEY (`tenantId`, `createdBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_runId_fkey` FOREIGN KEY (`tenantId`, `runId`) REFERENCES `ReconciliationRun`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_refundId_fkey` FOREIGN KEY (`tenantId`, `refundId`) REFERENCES `Refund`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ReconciliationItem` ADD CONSTRAINT `ReconciliationItem_tenantId_handledBy_fkey` FOREIGN KEY (`tenantId`, `handledBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PaymentEvent` ADD CONSTRAINT `PaymentEvent_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `PaymentEvent` ADD CONSTRAINT `PaymentEvent_tenantId_refundId_fkey` FOREIGN KEY (`tenantId`, `refundId`) REFERENCES `Refund`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `PaymentEvent` ADD CONSTRAINT `PaymentEvent_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `IdempotencyRecord` ADD CONSTRAINT `IdempotencyRecord_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `OutboxEvent` ADD CONSTRAINT `OutboxEvent_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `InvoiceApplication` ADD CONSTRAINT `InvoiceApplication_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `InvoiceApplication` ADD CONSTRAINT `InvoiceApplication_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `InvoiceApplication` ADD CONSTRAINT `InvoiceApplication_wxUserId_fkey` FOREIGN KEY (`wxUserId`) REFERENCES `WxUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `InvoiceApplication` ADD CONSTRAINT `InvoiceApplication_tenantId_processedBy_fkey` FOREIGN KEY (`tenantId`, `processedBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PlatformCollectionPolicy` ADD CONSTRAINT `PlatformCollectionPolicy_changedBy_fkey` FOREIGN KEY (`changedBy`) REFERENCES `AdminUser`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `TenantCollectionPolicy` ADD CONSTRAINT `TenantCollectionPolicy_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TenantCollectionPolicy` ADD CONSTRAINT `TenantCollectionPolicy_platformPolicyId_fkey` FOREIGN KEY (`platformPolicyId`) REFERENCES `PlatformCollectionPolicy`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `TenantCollectionPolicy` ADD CONSTRAINT `TenantCollectionPolicy_tenantId_changedBy_fkey` FOREIGN KEY (`tenantId`, `changedBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `CommunityCollectionPolicy` ADD CONSTRAINT `CommunityCollectionPolicy_tenantId_communityId_fkey` FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CommunityCollectionPolicy` ADD CONSTRAINT `CommunityCollectionPolicy_tenantId_tenantPolicyId_fkey` FOREIGN KEY (`tenantId`, `tenantPolicyId`) REFERENCES `TenantCollectionPolicy`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CommunityCollectionPolicy` ADD CONSTRAINT `CommunityCollectionPolicy_tenantId_changedBy_fkey` FOREIGN KEY (`tenantId`, `changedBy`) REFERENCES `AdminUser`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
