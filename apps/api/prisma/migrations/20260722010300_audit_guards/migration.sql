-- Fail before persistent DDL when Task 1 data contains a global audit row whose
-- tenantId does not reference an existing tenant. The former nullable composite
-- community foreign key could not validate this case.
CREATE TEMPORARY TABLE `_audit_guards_preflight` (
    `missing_tenant_references` BIGINT UNSIGNED NOT NULL,

    CONSTRAINT `audit_guards_preflight_tenant_reference_chk`
      CHECK (`missing_tenant_references` = 0)
);

INSERT INTO `_audit_guards_preflight` (`missing_tenant_references`)
SELECT COUNT(*)
FROM `AuditLog` AS `a`
LEFT JOIN `Tenant` AS `t` ON `t`.`id` = `a`.`tenantId`
WHERE `t`.`id` IS NULL;

DROP TEMPORARY TABLE `_audit_guards_preflight`;

-- Avoid filesort scanning and locking rows beyond LIMIT during ordered SKIP LOCKED claims.
CREATE INDEX `OutboxEvent_tenantId_availableAt_createdAt_id_idx`
  ON `OutboxEvent`(`tenantId`, `availableAt`, `createdAt`, `id`);

-- Parent keys are immutable once referenced by an audit row. MySQL cascades do not
-- invoke child-table triggers, so both relations must reject parent updates/deletes.
ALTER TABLE `AuditLog`
    DROP FOREIGN KEY `AuditLog_tenantId_communityId_fkey`,
    ADD CONSTRAINT `AuditLog_tenantId_fkey`
      FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT `AuditLog_tenantId_communityId_restrict_fkey`
      FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`)
      ON DELETE RESTRICT ON UPDATE RESTRICT;

DROP TRIGGER IF EXISTS `AuditLog_before_update_append_only`;
CREATE TRIGGER `AuditLog_before_update_append_only`
BEFORE UPDATE ON `AuditLog`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'AuditLog is append-only: UPDATE is forbidden';

DROP TRIGGER IF EXISTS `AuditLog_before_delete_append_only`;
CREATE TRIGGER `AuditLog_before_delete_append_only`
BEFORE DELETE ON `AuditLog`
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'AuditLog is append-only: DELETE is forbidden';
