# Single-Community Pilot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a production-grade single-community pilot with draft/imported bills, one-bill payments, collection controls, full refunds, offline settlement, daily reconciliation, auditable receipts, invoice requests, and hardened identity flows.

**Architecture:** Extend the existing NestJS/Prisma finance domain without replacing the current payment provider. Use additive and backfilled migrations, preserve read compatibility for legacy multi-bill payments, place every financial transition in an idempotent database transaction, and expose the new workflows through the existing Vue admin and native WeChat mini program.

**Tech Stack:** Node.js 22, TypeScript, NestJS 11, Prisma/MySQL, Jest/Supertest, Vue 3/Element Plus/Vite, native WeChat Mini Program, WeChat Pay API v3, pnpm.

---

### Task 1: Additive Finance Schema And Compatibility Migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260722010000_finance_expand/migration.sql`
- Modify: `apps/api/src/tenant/tenant-extension.ts`
- Modify: `packages/shared/src/enums.ts`
- Test: `apps/api/test/payment.e2e-spec.ts`
- Test: `apps/api/test/bill-run.e2e-spec.ts`

**Step 1: Write failing compatibility tests**

Add E2E assertions that legacy bills and multi-bill payments remain readable after the new fields are introduced. Add tenant-isolation tests for every new tenant model.

**Step 2: Run tests and verify failure**

Run: `pnpm --filter @pf/api test:e2e -- --runInBand payment.e2e-spec.ts bill-run.e2e-spec.ts`

Expected: FAIL because the new models and fields do not exist.

**Step 3: Add schema types and additive fields**

Add `DRAFT/REFUNDING/REFUNDED` bill states, `PREPAY_UNKNOWN` payment state, `OFFLINE` channel, batch/source/refund/reconciliation/invoice/audit/idempotency enums, `BillBatch`, `Refund`, `RefundAttempt`, `ReconciliationRun`, `ReconciliationItem`, `AuditLog`, `PaymentEvent`, `IdempotencyRecord`, `OutboxEvent`, `InvoiceApplication`, and collection policy models/fields. Every tenant-domain model carries `tenantId`; community-specific models also carry `communityId`.

Keep `PaymentBill` and nullable legacy `billRunId` for compatibility. Add nullable `Payment.billId`; do not add a lifetime unique index to it.

**Step 4: Write the expansion-only SQL migration**

`finance_expand` adds nullable fields, enums, tables, indexes, and foreign keys only. It performs no historical backfill, no non-null switch, and no old-column removal. This migration is an independently deployable checkpoint that remains compatible with the currently running application. Never edit it after application.

Keep `Payment.communityId` nullable for history. New application code later requires it for new orders, while historical ownership can still derive from `PaymentBill`.

**Step 5: Update tenant extension and shared enums**

Register every new tenant model in `TENANT_MODELS`. Export new enum constants and types from `packages/shared/src/enums.ts`.

**Step 6: Generate and validate Prisma client**

Run: `pnpm --filter @pf/api prisma:generate && pnpm --filter @pf/api exec prisma validate`

Expected: Prisma schema valid and client generated.

**Step 7: Run focused E2E and unit tests**

Run: `pnpm --filter @pf/api test:e2e -- --runInBand payment.e2e-spec.ts bill-run.e2e-spec.ts`

Expected: PASS, including legacy compatibility and tenant isolation.

**Step 8: Commit**

```bash
git add apps/api/prisma packages/shared/src/enums.ts apps/api/src/tenant/tenant-extension.ts apps/api/test
git commit -m "feat: 扩展灰度财务数据模型"
```

### Task 2: Add Idempotency And Append-Only Audit Infrastructure

**Files:**
- Create: `apps/api/src/audit/audit.module.ts`
- Create: `apps/api/src/audit/audit.service.ts`
- Create: `apps/api/src/audit/admin-audit.controller.ts`
- Create: `apps/api/src/audit/audit.service.spec.ts`
- Create: `apps/api/src/common/idempotency.service.ts`
- Create: `apps/api/src/common/idempotency.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/prisma/migrations/20260722010300_audit_guards/migration.sql`
- Create: `apps/api/src/notify/outbox.service.ts`
- Create: `apps/api/src/notify/outbox.service.spec.ts`

**Step 1: Write failing tests**

Test same-key/same-payload replay, same-key/different-payload rejection, actor/action scoping, append-only audit writes, tenant filtering, rejection of update/delete attempts, transactionally-created Outbox events, and idempotent event claiming.

**Step 2: Run tests and verify failure**

Run: `pnpm --filter @pf/api test -- audit.service.spec.ts idempotency.service.spec.ts outbox.service.spec.ts --runInBand`

Expected: FAIL because services do not exist.

**Step 3: Implement minimal services**

Hash canonical JSON payloads with SHA-256. Persist idempotency results without secrets. Write audit entries with actor, action, object, reason, request ID, IP, User-Agent, and before/after summaries. Implement the Outbox persistence/claiming primitive here so later bill, payment, refund, binding, and invoice transactions can emit events before any delivery adapter exists.

**Step 4: Protect audit rows in MySQL**

Add migration triggers or equivalent database permissions that reject `UPDATE` and `DELETE` on `AuditLog` for the application path.

**Step 5: Add read-only admin endpoint**

Implement paginated filters by action, actor, object, community, and time. Do not expose mutation endpoints.

**Step 6: Run tests**

Run: `pnpm --filter @pf/api test -- audit.service.spec.ts idempotency.service.spec.ts outbox.service.spec.ts --runInBand`

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/audit apps/api/src/common apps/api/src/notify/outbox.service.ts apps/api/src/notify/outbox.service.spec.ts apps/api/src/app.module.ts apps/api/prisma/migrations
git commit -m "feat: 增加财务幂等与审计基础设施"
```

### Task 3: Harden Administrator Sessions

**Files:**
- Modify: `apps/api/src/admin/admin-auth.controller.ts`
- Modify: `apps/api/src/auth/admin.guard.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/admin/admin-auth.service.spec.ts`
- Modify: `apps/api/test/admin-auth.e2e-spec.ts`
- Modify: `apps/admin/src/views/Login.vue`
- Modify: `apps/api/prisma/seed.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260722030000_admin_session_hardening/migration.sql`

**Step 1: Write failing auth tests**

Cover failed-attempt counting, timed lockout, disabled account rejection, tokenVersion revocation, password-change invalidation, IP+account rate limit, successful reset after login, 12+ character strong-password rules for initial and changed passwords, forced password change for every pre-existing administrator, restricted sessions before that change, demo-account disabling, and production startup rejection when `JWT_SECRET` is missing or equals a public/default value.

**Step 2: Run tests and verify failure**

Run: `pnpm --filter @pf/api test -- admin-auth.service.spec.ts --runInBand`

Expected: FAIL on missing lockout and session checks.

**Step 3: Implement lockout and live-account checks**

Persist `failedLoginCount`, `lockedUntil`, `tokenVersion`, `passwordChangedAt`, and `mustChangePassword` through an explicit production migration. The migration sets `mustChangePassword=true` and initializes or increments tokenVersion for every pre-existing administrator so migration-before JWTs are rejected. Disable documented demo accounts in production and allow a restricted session to access only the password-change endpoint until rotation succeeds. Increment tokenVersion again on rotation. Enforce the same strong-password policy when creating tenant administrators and changing passwords. Remove the production JWT fallback and fail closed on missing/default secrets. Keep the confirmed single-factor and all-admin financial permission policy.

**Step 4: Add rate limiting and neutral login errors**

Use shared storage supported by the deployed instance; never reveal whether username or password was wrong.

**Step 5: Update login UI states**

Display generic lockout/retry messages without disclosing account existence.

**Step 6: Run tests and build**

Run: `pnpm --filter @pf/api test -- admin-auth.service.spec.ts --runInBand && pnpm --filter @pf/admin build`

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/admin apps/api/src/auth apps/api/test/admin-auth.e2e-spec.ts apps/admin/src/views/Login.vue apps/api/prisma
git commit -m "feat: 加固物业后台登录与会话"
```

### Task 4: Implement Layered Collection Controls

**Files:**
- Create: `apps/api/src/payment/collection-policy.service.ts`
- Create: `apps/api/src/payment/collection-policy.service.spec.ts`
- Create: `apps/api/src/payment/admin-collection.controller.ts`
- Modify: `apps/api/src/payment/payment.module.ts`
- Modify: `apps/api/src/payment/payment.service.ts`
- Modify: `apps/api/src/payment/payment.service.spec.ts`
- Modify: `packages/shared/src/error-codes.ts`

**Step 1: Write failing policy tests**

Cover platform, tenant, and community precedence; mandatory reason; transaction-time recheck; paused new payment rejection; and acceptance of callbacks/refunds/reconciliation while paused.

**Step 2: Run tests and verify failure**

Run: `pnpm --filter @pf/api test -- collection-policy.service.spec.ts payment.service.spec.ts --runInBand`

Expected: FAIL because policy checks do not exist.

**Step 3: Implement policy service and admin endpoints**

Provide read/update operations with audit entries. Platform changes require super admin; tenant/community changes accept every active property admin as confirmed.

**Step 4: Enforce merchant deployment scope**

Add required `WX_PAY_ALLOWED_TENANT_ID` and `WX_PAY_ALLOWED_COMMUNITY_ID`. Reject WeChat prepay outside the configured pilot scope before bill reservation.

**Step 5: Enforce policy in payment transaction**

Lock and re-read policy rows in the same transaction that reserves the bill.

**Step 6: Run tests**

Run: `pnpm --filter @pf/api test -- collection-policy.service.spec.ts payment.service.spec.ts --runInBand`

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/payment packages/shared/src/error-codes.ts
git commit -m "feat: 增加分层暂停收款控制"
```

### Task 5: Switch New Payments To One Bill Per Order

**Files:**
- Modify: `apps/api/src/payment/owner-payment.controller.ts`
- Modify: `apps/api/src/payment/payment.service.ts`
- Modify: `apps/api/src/payment/payment.service.spec.ts`
- Modify: `apps/api/test/payment.e2e-spec.ts`
- Modify: `apps/miniprogram/pages/bill/bill.js`
- Modify: `apps/miniprogram/pages/bill/bill.wxml`
- Modify: `apps/miniprogram/pages/pay-confirm/pay-confirm.js`
- Modify: `apps/miniprogram/pages/pay-confirm/pay-confirm.wxml`
- Modify: `tests/miniprogram-payment-flow.test.js`

**Step 1: Write failing API and mini-program tests**

Require `{billId, requestId}`, reject arrays, reuse idempotent requests, allow historical failed attempts, preserve legacy multi-bill reads, write payment-creation audit records transactionally, and remove all multi-select UI behavior.

**Step 2: Run tests and verify failure**

Run: `pnpm --filter @pf/api test -- payment.service.spec.ts --runInBand && node --test tests/miniprogram-payment-flow.test.js`

Expected: FAIL on old `billIds[]` contract and multi-select UI.

**Step 3: Implement the new contract**

Create new orders with `Payment.billId`; retain legacy `PaymentBill` reads. Store amount and merchant scope snapshots. Use request idempotency.

**Step 4: Handle uncertain prepay results and schedule recovery**

Only explicit WeChat rejection releases the bill immediately. Network/timeouts become `PREPAY_UNKNOWN`, remain reserved, and enter recovery query. Extend the existing scheduled recovery service in this task to scan both stale `CREATED` and `PREPAY_UNKNOWN` orders, use a multi-instance lease, and keep retrying until a bounded terminal decision is obtained.

**Step 5: Update mini-program pages**

Each bill has a pay action. The confirmation page re-fetches server bill amount and collection policy rather than trusting global pending selections.

**Step 6: Run tests**

Run: `pnpm --filter @pf/api test -- payment.service.spec.ts --runInBand && node --test tests/miniprogram-payment-flow.test.js`

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/payment apps/api/test/payment.e2e-spec.ts apps/miniprogram/pages tests/miniprogram-payment-flow.test.js
git commit -m "feat: 切换为单账单单支付订单"
```

### Task 6: Persist Callback Audit And Immutable Receipts

**Files:**
- Modify: `apps/api/src/payment/payment.service.ts`
- Modify: `apps/api/src/payment/wxpay-notify.controller.ts`
- Modify: `apps/api/src/payment/wxpay-notify.controller.spec.ts`
- Modify: `apps/api/src/payment/payment.service.spec.ts`
- Modify: `apps/miniprogram/pages/receipt/receipt.js`
- Modify: `apps/miniprogram/pages/receipt/receipt.wxml`

**Step 1: Write failing callback-race tests**

Cover notify-first, query-first then notify, duplicate notify, transaction ID uniqueness, audit timestamp persistence, and non-success receipt rejection.

**Step 2: Run tests and verify failure**

Run: `pnpm --filter @pf/api test -- wxpay-notify.controller.spec.ts payment.service.spec.ts --runInBand`

Expected: FAIL because callback source and receipt snapshots are not stored.

**Step 3: Persist notification evidence**

After signature verification and decryption, store a `PaymentEvent` and set `wxpayNotifiedAt` even if payment already succeeded through query. Keep the success transition idempotent.

**Step 4: Generate receipt snapshot transactionally**

Create a unique receipt number and immutable payer-independent snapshot when payment becomes successful.

**Step 5: Update receipt page**

Render only backend snapshots and mark refunded receipts void.

**Step 6: Run tests**

Run: `pnpm --filter @pf/api test -- wxpay-notify.controller.spec.ts payment.service.spec.ts --runInBand`

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/payment apps/miniprogram/pages/receipt
git commit -m "feat: 记录支付回调证据与不可变收据"
```

### Task 7: Implement Full WeChat Refunds

**Files:**
- Modify: `apps/api/src/payment/provider.ts`
- Modify: `apps/api/src/payment/wxpay-direct.provider.ts`
- Modify: `apps/api/src/payment/wxpay-direct.provider.spec.ts`
- Create: `apps/api/src/payment/refund.service.ts`
- Create: `apps/api/src/payment/refund.service.spec.ts`
- Create: `apps/api/src/payment/refund-recovery.service.ts`
- Create: `apps/api/src/payment/refund-recovery.service.spec.ts`
- Create: `apps/api/src/payment/admin-refund.controller.ts`
- Create: `apps/api/src/payment/wxpay-refund-notify.controller.ts`
- Create: `apps/api/src/payment/wxpay-refund-notify.controller.spec.ts`
- Modify: `apps/api/src/payment/payment.module.ts`
- Create: `apps/api/test/refund.e2e-spec.ts`

**Step 1: Write failing provider tests**

Test signed `/v3/refund/domestic/refunds`, refund query, response verification, refund notification verification/decryption, public-key ID validation, amount/currency checks, and failure mapping.

**Step 2: Run provider tests and verify failure**

Run: `pnpm --filter @pf/api test -- wxpay-direct.provider.spec.ts --runInBand`

Expected: FAIL on missing refund methods.

**Step 3: Extend provider**

Implement create/query refund and parse refund notification with the same strict signature, time-window, merchant, amount, and AES-GCM checks used for payment notifications.

**Step 4: Write failing refund service tests**

Cover successful full refund, amount derived from order, duplicate request replay, concurrent attempts, process interruption recovery with stable refund number, scheduled recovery of stale `CREATED/PROCESSING` refunds under a multi-instance lease, explicit failure restoring `PAID`, success locking `REFUNDED`, legacy multi-bill and legacy cross-community refunds, paused collection, transactional audit writes, and offline reversal.

**Step 5: Implement refund aggregate and controllers**

Use `RefundAttempt` for outbound calls and a single aggregate per payment. Do not accept client-entered amount. Add the scheduled refund recovery executor in this task; it resumes with the stable merchant refund number and queries ambiguous attempts until terminal.

**Step 6: Run unit and E2E tests**

Run: `pnpm --filter @pf/api test -- refund.service.spec.ts wxpay-refund-notify.controller.spec.ts --runInBand`

Run: `pnpm --filter @pf/api test:e2e -- --runInBand refund.e2e-spec.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/payment apps/api/test/refund.e2e-spec.ts
git commit -m "feat: 接入微信全额退款闭环"
```

### Task 8: Build Draft Bills, Import Validation, Publish, Cancel, And Reissue

**Files:**
- Modify: `apps/api/src/billing/bill-run.service.ts`
- Modify: `apps/api/src/billing/bill-run.controller.ts`
- Modify: `apps/api/src/billing/schedule.service.ts`
- Modify: `apps/api/src/billing/fee-rules.controller.ts`
- Create: `apps/api/prisma/migrations/20260722080000_finance_backfill/migration.sql`
- Create: `apps/api/src/billing/bill-import.service.ts`
- Create: `apps/api/src/billing/bill-import.controller.ts`
- Create: `apps/api/src/billing/bill-import.service.spec.ts`
- Create: `apps/api/src/billing/bill-workflow.service.ts`
- Create: `apps/api/src/billing/bill-workflow.service.spec.ts`
- Modify: `apps/api/src/owner/owner-bills.controller.ts`
- Modify: `apps/api/src/admin/stats.controller.ts`
- Modify: `apps/api/test/bill-run.e2e-spec.ts`
- Modify: `apps/api/package.json`

**Step 1: Add parser dependency deliberately**

Use a maintained structured `.xlsx`/`.csv` parser. Record the chosen package and version in the lockfile; do not parse CSV with `split(',')`.

**Step 2: Write failing workflow tests**

Cover rule-generated drafts, imported drafts, file hash idempotency, row-key idempotency, duplicate/missing house/invalid amount/paid conflict issues, atomic publish, immutable published fields, cancel reason, replacement links, draft invisibility to owners/stats, transactional audit/Outbox writes, and cancellation races with active payment and success callbacks. Cancellation must require `paymentId IS NULL`; if an active order exists, query and close it before a new cancellation transaction.

**Step 3: Run tests and verify failure**

Run: `pnpm --filter @pf/api test -- bill-import.service.spec.ts bill-workflow.service.spec.ts --runInBand`

Expected: FAIL because workflows do not exist.

**Step 4: Add the idempotent historical backfill migration**

Create `BillBatch` rows for existing `BillRun` data, backfill existing bills as published `RULE` bills, and backfill `Payment.communityId` only when all legacy `PaymentBill` rows belong to one community. Cross-community legacy orders retain `communityId=null`; refund, audit, and reconciliation derive their community set from `PaymentBill`. Inventory every existing `FORMULA` rule, whether enabled or disabled, force all of them disabled, and persist/report the affected rule IDs and disposition status. Add same-community and cross-community legacy fixtures and prove the migration can be resumed safely.

**Step 5: Implement import preview and draft creation**

Support upload preview followed by explicit confirmation. Reject partial automatic publishing and persist structured row issues.

**Step 6: Refactor rule generation**

Scheduled and manual runs produce `DRAFT` batches and Outbox events only after publication. Reject creation, parameter editing, or direct enabling of arbitrary `FORMULA` rules and fix the admin/backend rule-edit contract. Expose the backfill report and a controlled conversion action that atomically changes an old formula to `FIXED/BY_AREA/METER/SHARE`, or permanently retires it in favor of import. A `FORMULA` rule can never be re-enabled. Add a launch-readiness gate requiring zero unresolved formula dispositions.

**Step 7: Implement publish/cancel/reissue**

Freeze all business fields at publish. Reissue creates a new bill linked to the canceled/refunded bill.

**Step 8: Run unit and E2E tests**

Run: `pnpm --filter @pf/api test -- bill-import.service.spec.ts bill-workflow.service.spec.ts --runInBand`

Run: `pnpm --filter @pf/api test:e2e -- --runInBand bill-run.e2e-spec.ts`

Expected: PASS.

**Step 9: Commit**

```bash
git add apps/api/src/billing apps/api/src/owner apps/api/src/admin apps/api/test apps/api/prisma apps/api/package.json pnpm-lock.yaml
git commit -m "feat: 增加账单草稿导入发布与重开"
```

### Task 9: Add Offline Settlement

**Files:**
- Create: `apps/api/src/payment/offline-payment.service.ts`
- Create: `apps/api/src/payment/offline-payment.service.spec.ts`
- Create: `apps/api/src/payment/admin-payment.controller.ts`
- Modify: `apps/api/src/payment/payment.module.ts`
- Create: `apps/api/test/offline-payment.e2e-spec.ts`

**Step 1: Write failing tests**

Cover voucher uniqueness, required paid time/operator/payer snapshot, active WeChat order rejection, query-and-close prerequisite, atomic `UNPAID + paymentId null` match, idempotent request replay, paused historical payment rule, transactional audit write, and full offline reversal.

**Step 2: Run and verify failure**

Run: `pnpm --filter @pf/api test -- offline-payment.service.spec.ts --runInBand`

Expected: FAIL because offline service does not exist.

**Step 3: Implement service and admin endpoints**

Create a `SUCCESS/OFFLINE` payment and receipt snapshot in one transaction. Reversal uses the refund aggregate without calling WeChat.

**Step 4: Run unit and E2E tests**

Run: `pnpm --filter @pf/api test -- offline-payment.service.spec.ts --runInBand`

Run: `pnpm --filter @pf/api test:e2e -- --runInBand offline-payment.e2e-spec.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/payment apps/api/test/offline-payment.e2e-spec.ts
git commit -m "feat: 增加线下缴费核销与冲正"
```

### Task 10: Implement Daily WeChat Reconciliation

**Files:**
- Rename: `apps/api/src/payment/payment-reconciliation.service.ts` to `apps/api/src/payment/payment-recovery.service.ts`
- Rename: `apps/api/src/payment/payment-reconciliation.service.spec.ts` to `apps/api/src/payment/payment-recovery.service.spec.ts`
- Create: `apps/api/src/reconciliation/reconciliation.module.ts`
- Create: `apps/api/src/reconciliation/wechat-bill.provider.ts`
- Create: `apps/api/src/reconciliation/reconciliation.service.ts`
- Create: `apps/api/src/reconciliation/reconciliation.service.spec.ts`
- Create: `apps/api/src/reconciliation/admin-reconciliation.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/reconciliation.e2e-spec.ts`

**Step 1: Rename recovery logic without regression**

Run existing tests after rename and update module references. Preserve the Task 5 behavior that scans both stale `CREATED` and `PREPAY_UNKNOWN` payments under a lease.

**Step 2: Write failing channel adapter tests**

Cover signed transaction/refund bill requests, download URL handling, response verification, CSV parsing, Shanghai billing date, and delayed availability.

**Step 3: Write failing reconciliation tests**

Cover five difference types, file hashes, unique daily run, repeated runs, multi-instance lease, retry schedule, automatic local confirmation, manual resolution, and audit writes.

**Step 4: Implement adapter, service, schedule, and admin API**

Never log raw bills containing sensitive data. Persist normalized summaries and necessary identifiers only.

**Step 5: Run unit and E2E tests**

Run: `pnpm --filter @pf/api test -- reconciliation.service.spec.ts payment-recovery.service.spec.ts --runInBand`

Run: `pnpm --filter @pf/api test:e2e -- --runInBand reconciliation.e2e-spec.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/payment apps/api/src/reconciliation apps/api/src/app.module.ts apps/api/test/reconciliation.e2e-spec.ts
git commit -m "feat: 增加微信支付每日自动对账"
```

### Task 11: Add Invoice Applications And Notification Outbox

**Files:**
- Create: `apps/api/src/invoice/invoice.module.ts`
- Create: `apps/api/src/invoice/invoice.service.ts`
- Create: `apps/api/src/invoice/owner-invoice.controller.ts`
- Create: `apps/api/src/invoice/admin-invoice.controller.ts`
- Create: `apps/api/src/invoice/invoice.service.spec.ts`
- Modify: `apps/api/src/notify/notify.service.ts`
- Modify: `apps/api/src/notify/notify.tokens.ts`
- Modify: `apps/api/src/notify/outbox.service.ts`
- Modify: `apps/api/src/notify/outbox.service.spec.ts`
- Modify: `apps/api/src/payment/refund.service.ts`
- Modify: `apps/api/src/app.module.ts`

**Step 1: Write failing invoice tests**

Cover successful-payment eligibility, title/tax number validation, duplicate application idempotency, status transitions, tenant isolation, transactional audit writes, refund cancellation, and issued-invoice reversal tasks.

**Step 2: Write failing Outbox tests**

Cover transactionally-created events, unique recipient/channel delivery, missing template, denied subscription, retryable failure, business transaction independence, and atomic refund-success linkage that cancels unissued invoice applications or creates reversal tasks for issued invoices.

**Step 3: Implement invoice APIs and Outbox delivery**

Support bill publish, binding review, payment, refund, and invoice events. Do not claim tax invoice issuance by this system.

**Step 4: Run tests**

Run: `pnpm --filter @pf/api test -- invoice.service.spec.ts outbox.service.spec.ts --runInBand`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/invoice apps/api/src/notify apps/api/src/app.module.ts
git commit -m "feat: 增加开票申请与订阅通知事务箱"
```

### Task 12: Harden Phone Binding And Community Isolation

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.service.spec.ts`
- Modify: `apps/api/src/owner/owner-houses.controller.ts`
- Modify: `apps/api/src/admin/bindings.controller.ts`
- Modify: `apps/api/test/auth.e2e-spec.ts`
- Modify: `apps/api/src/community/announcements.controller.ts`
- Create: `apps/api/src/auth/owner-account.service.ts`
- Create: `apps/api/src/auth/owner-account.controller.ts`
- Create: `apps/api/src/auth/owner-account.service.spec.ts`
- Add/Modify: corresponding announcement tests

**Step 1: Write failing identity tests**

Cover phone evidence timestamps, exact normalized match, stale phone-only binding revocation, preservation of manually approved bindings, rejected-binding cleanup, audit events, announcement cross-community denial, owner-requested account deletion, token revocation, identity anonymization, removal of active bindings, and retention of financial/audit rows.

**Step 2: Run tests and verify failure**

Run: `pnpm --filter @pf/api test -- auth.service.spec.ts --runInBand`

Expected: FAIL on stale-binding and evidence behavior.

**Step 3: Implement evidence-aware binding**

Do not overwrite manual approval evidence with phone-match source. Return only masked phone data to clients. Account deletion anonymizes identity fields, increments owner token version, removes active bindings and subscriptions, and never deletes financial, refund, invoice, reconciliation, or audit records.

**Step 4: Fix community authorization**

Require an active binding in the announcement's community, not merely the same tenant.

**Step 5: Run unit and E2E tests**

Run: `pnpm --filter @pf/api test -- auth.service.spec.ts --runInBand`

Run: `pnpm --filter @pf/api test:e2e -- --runInBand auth.e2e-spec.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/auth apps/api/src/owner apps/api/src/admin apps/api/src/community apps/api/test
git commit -m "fix: 加固手机号绑房与小区访问边界"
```

### Task 13: Build Admin Finance Workspaces

**Files:**
- Modify: `apps/admin/src/router.ts`
- Modify: `apps/admin/src/layout/Layout.vue`
- Modify: `apps/admin/src/api.ts`
- Modify: `apps/admin/src/composables.ts`
- Modify: `apps/admin/src/views/Bills.vue`
- Modify: `apps/admin/src/views/FeeRules.vue`
- Create: `apps/admin/src/views/BillingSettings.vue`
- Create: `apps/admin/src/views/Payments.vue`
- Create: `apps/admin/src/views/Reconciliations.vue`
- Create: `apps/admin/src/views/InvoiceApplications.vue`
- Create: `apps/admin/src/views/AuditLogs.vue`

**Step 1: Add focused component tests if existing harness supports them**

Test API payloads, status actions, destructive confirmations, upload preview, and no optimistic financial state mutation. If no component harness exists, add Vitest/Vue Test Utils before implementation.

**Step 2: Implement routes and menu**

Use existing Element Plus patterns and tenant header behavior. Do not create nested cards or marketing layouts.

**Step 3: Build bill workspace**

Provide import preview, issues, draft edit, publish summary, cancel, and reissue.

**Step 4: Build settings, payments, refund, and offline UI**

Use explicit status labels, reason inputs, one confirmation, stable table dimensions, and server refresh after every action.

**Step 5: Build reconciliation, invoice, and audit UI**

All audit data remains read-only.

**Step 6: Run tests and build**

Run: `pnpm --filter @pf/admin test && pnpm --filter @pf/admin build`

Expected: PASS; no text overflow at desktop widths.

**Step 7: Commit**

```bash
git add apps/admin
git commit -m "feat: 增加物业财务管理工作台"
```

### Task 14: Complete Mini-Program Refund, Invoice, And Pause UX

**Files:**
- Modify: `apps/miniprogram/app.json`
- Modify: `apps/miniprogram/pages/index/index.js`
- Modify: `apps/miniprogram/pages/index/index.wxml`
- Modify: `apps/miniprogram/pages/payments/payments.js`
- Modify: `apps/miniprogram/pages/payments/payments.wxml`
- Modify: `apps/miniprogram/pages/pay-success/pay-success.js`
- Modify: `apps/miniprogram/pages/pay-success/pay-success.wxml`
- Create: `apps/miniprogram/pages/invoice-apply/invoice-apply.{js,json,wxml,wxss}`
- Create: `apps/miniprogram/pages/invoices/invoices.{js,json,wxml,wxss}`
- Modify: `apps/miniprogram/utils/subscribe.js`
- Modify: `tests/miniprogram-auth-flow.test.js`
- Modify: `tests/miniprogram-payment-flow.test.js`

**Step 1: Write failing static-flow tests**

Cover single-bill navigation, paused collection, backend-only success, refunding/refunded display, void receipt, invoice eligibility, and subscription rejection fallback.

**Step 2: Run and verify failure**

Run: `node --test tests/miniprogram-auth-flow.test.js tests/miniprogram-payment-flow.test.js`

Expected: FAIL on missing pages and states.

**Step 3: Implement pages and states**

Keep all financial status server-derived. Do not allow invoice requests on refunded or non-success orders.

**Step 4: Run tests**

Run: `node --test tests/miniprogram-auth-flow.test.js tests/miniprogram-payment-flow.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/miniprogram tests
git commit -m "feat: 完善业主端退款开票与停收状态"
```

### Task 15: Implement Operational Alerts And Pilot Metrics

**Files:**
- Create: `apps/api/src/operations/operations.module.ts`
- Create: `apps/api/src/operations/alert.service.ts`
- Create: `apps/api/src/operations/alert.service.spec.ts`
- Create: `apps/api/src/operations/pilot-metrics.service.ts`
- Create: `apps/api/src/operations/pilot-metrics.service.spec.ts`
- Create: `apps/api/src/operations/admin-operations.controller.ts`
- Create: `apps/api/src/operations/incident.service.ts`
- Create: `apps/api/src/operations/incident.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/payment/wxpay-notify.controller.ts`
- Modify: `apps/api/src/payment/wxpay-refund-notify.controller.ts`
- Modify: `apps/api/src/payment/payment-recovery.service.ts`
- Modify: `apps/api/src/payment/refund-recovery.service.ts`
- Modify: `apps/api/src/reconciliation/reconciliation.service.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260722150000_operational_alerts/migration.sql`
- Modify: `apps/api/src/tenant/tenant-extension.ts`
- Modify: `.env.example`
- Modify: `apps/api/.env.example`

**Step 1: Write failing alert tests**

Cover payment callback rejection, refund callback rejection, stale unresolved payment/refund, reconciliation difference, scheduled-task failure, deduplication, persisted delivery attempts across restart, retry, and secret redaction. Add tenant-scoped `OperationalAlert`, `AlertAttempt`, and `Incident` models and tenant-isolation tests. Critical alerts create or reopen a deduplicated incident; incidents transition `OPEN -> ACKNOWLEDGED -> RESOLVED`, record actor/reason/timestamps, and write audit entries. Recurrence after resolution reopens the incident. In pilot mode, missing alert destination must be exposed as an unhealthy launch readiness check.

**Step 2: Write failing metrics tests**

Calculate the 30-day payment technical success rate, duplicate-charge count, unresolved reconciliation differences, refund completion rate, severe incident count, and money-loss indicator from persisted records rather than logs.

**Step 3: Implement alert adapter and readiness endpoint**

Support an HTTPS operations webhook through `OPS_ALERT_WEBHOOK`; keep the adapter replaceable. Persist delivery attempts and never include full phone, token, private key, APIv3 key, or raw callback body.

**Step 4: Integrate alert and incident producers**

Emit deduplicated alerts from payment/refund callback rejection, recovery exhaustion, reconciliation differences, and scheduler failures. Map critical alerts to persisted incidents. Add admin endpoints to list, acknowledge, resolve, and inspect incidents; state changes are idempotent and audited.

**Step 5: Implement pilot metrics endpoint**

Return daily and rolling-30-day values with explicit numerator/denominator definitions and the agreed pass/fail thresholds.

**Step 6: Run tests**

Run: `pnpm --filter @pf/api test -- alert.service.spec.ts incident.service.spec.ts pilot-metrics.service.spec.ts --runInBand`

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/api/src/operations apps/api/src/payment apps/api/src/reconciliation apps/api/src/tenant apps/api/src/app.module.ts apps/api/prisma .env.example apps/api/.env.example
git commit -m "feat: 增加灰度告警与运行指标"
```

### Task 16: Full Verification, Deployment, And Production Acceptance

**Files:**
- Modify: `.env.example`
- Modify: `apps/api/.env.example`
- Modify: `README.md`
- Modify: `docs/项目说明书.md`
- Create: `docs/runbooks/单小区灰度发布与回滚.md`
- Create: `docs/runbooks/支付退款对账处置.md`
- Create: `docs/runbooks/云数据库备份能力核查.md`

**Step 1: Document configuration and runbooks**

Document merchant scope IDs, notification URLs, template IDs, reconciliation schedule, alert webhook, HTTPS-only requirement, collection switches, rollback procedure, backup evidence, and 24-hour incident workflow. Never include secret values. Stage and commit these runbooks before any production migration or deployment; the final documentation commit later contains only acceptance evidence and post-deploy facts.

**Step 2: Enforce backup and HTTPS preflight**

Before touching production, verify and record the cloud MySQL instance, latest successful backup, retention period, available restore point, restore permission, expected RPO/RTO, and recovery-procedure evidence. Verify the admin production URL is HTTPS-only. If any required evidence is absent, stop production migration/deployment even though no independent backup system is being added.

**Step 3: Run migration rehearsal**

Apply all migrations to a MySQL copy containing legacy bills, same-community multi-bill payments, and cross-community multi-bill payments. Verify row counts, totals, foreign keys, backfills, null legacy community ownership, and rollback-by-forward-fix procedure.

**Step 4: Run all automated verification**

Run: `pnpm test`

Run: `pnpm --filter @pf/api test:e2e -- --runInBand`

Run: `node --test tests/miniprogram-auth-flow.test.js tests/miniprogram-payment-flow.test.js`

Run: `pnpm build`

Expected: all tests and builds pass.

**Step 5: Run security and secret scans**

Verify no private key, APIv3 key, JWT secret, database password, token, raw callback, or full phone was added to Git or build context.

**Step 6: Review the complete branch**

Run a dedicated code review and resolve all P0/P1 findings. Do not merge the complete feature branch yet; record the exact Task 1 expansion commit and the final reviewed commit. The unrelated `outputs/工作日报.md` must never be included.

**Step 7: Prepare deployment prerequisites before pushing `main`**

Configure the integration tenant/community merchant allowlist, refund notification URL, alert webhook, templates, strong production JWT secret, and collection policies. If CloudBase credentials are unavailable, stop before pushing `main`; do not deploy code that depends on absent configuration.

**Step 8: Execute three production release checkpoints**

1. Fast-forward `main` only to the recorded Task 1 expansion commit, push it, and verify the old application continues serving against the additive schema.
2. Enter a documented maintenance window using a CloudBase/platform traffic fence that the old application cannot bypass. First reconcile and close every `CREATED/PREPAY_UNKNOWN` order, stop scheduled billing, block new business traffic, allow failed WeChat notifications to retry later, and drain or scale old revisions to zero. Run the restart-safe backfill as a one-off job, verify row-count and high-watermark queries show no late old writes, deploy the reviewed feature tip, verify new writes, and only then reopen traffic with collection still paused.
3. After all instances use the new path, generate a new immutable `finance_switch` schema and migration commit from verified production preflight queries. Apply that exact commit to a fresh copy of the latest production data, run migration-specific tests and the full suite, obtain a dedicated P0/P1 review, and only then deploy it separately. Do not include the switch migration in the initial feature branch.

At every checkpoint confirm CloudBase migration and service health. Verify invalid callback probes return real HTTP 401 and health returns HTTP 200.

**Step 9: Execute integration-community acceptance**

Verify real phone authorization, one-cent payment, persisted payment callback audit, full one-cent refund, refund notification audit, paused collection, offline settlement, daily reconciliation, receipt voiding, invoice request, alert delivery, and metrics collection.

**Step 10: Switch merchant scope to the formal pilot community**

Replace integration allowlist IDs with the approved formal tenant/community IDs, verify the formal community is accepted and the integration/other communities are rejected, then open only the formal pilot community. Never leave both integration and formal scopes enabled unintentionally.

**Step 11: Upload and release the mini program**

Generate preview, perform remote-capable checks, upload the release build, and submit/publish only after all automated and production gates pass.

**Step 12: Commit final acceptance evidence**

```bash
git add .env.example apps/api/.env.example README.md docs
git commit -m "docs: 完善单小区灰度发布与财务处置"
```
