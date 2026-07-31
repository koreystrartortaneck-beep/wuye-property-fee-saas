-- 补齐实际查询用到的索引组合。
--
-- 这些索引本身不改变任何行为，只是让已有查询不再全表扫或 filesort。
-- 逐条对应的查询与规模影响：
--
--   Bill(tenantId,status,communityId)   欠费清单 / 批量催缴。原先 status 落不到索引，
--                                       3000 户小区单月 12000+ 张未缴账单要在
--                                       @@index([tenantId]) 之后逐行过滤。
--   Bill(tenantId,period,status)        stats/summary、stats/by-community、today
--                                       都按账期查，而 period 此前完全无索引。
--   Bill(tenantId,createdAt)            账单列表默认 ORDER BY createdAt desc，
--                                       无此索引每次翻页都对全量行 filesort。
--   Payment(tenantId,channel,status,paidAt)
--                                       每日 10:30 的对账取当日流水。现有
--                                       (channel,status,createdAt) 前缀不含 tenantId，
--                                       paidAt 更是无索引，于是租户内全表扫。
--   Refund(tenantId,channel,status,refundedAt)  对账的退款侧，此前三列全无索引。
--   Refund(channel,status,requestedAt)  退款恢复任务每 10 分钟扫一次并按 requestedAt 排序。
--   NotifyLog(tenantId,sentAt)          通知记录列表按 sentAt desc；该表增长最快
--                                       （3000 户 × 3 类提醒 × 1.2 人/月 ≈ 每月 1 万行）。
--   HouseBinding(tenantId,status,createdAt)  实名审核列表：按状态筛 + 时间倒序。
--   Announcement(tenantId,status,pinned,publishedAt)  业主端每次进首页都查。

CREATE INDEX `Bill_tenantId_status_communityId_idx` ON `Bill`(`tenantId`, `status`, `communityId`);
CREATE INDEX `Bill_tenantId_period_status_idx` ON `Bill`(`tenantId`, `period`, `status`);
CREATE INDEX `Bill_tenantId_createdAt_idx` ON `Bill`(`tenantId`, `createdAt`);
CREATE INDEX `Payment_tenantId_channel_status_paidAt_idx` ON `Payment`(`tenantId`, `channel`, `status`, `paidAt`);
CREATE INDEX `Refund_tenantId_channel_status_refundedAt_idx` ON `Refund`(`tenantId`, `channel`, `status`, `refundedAt`);
CREATE INDEX `Refund_channel_status_requestedAt_idx` ON `Refund`(`channel`, `status`, `requestedAt`);
CREATE INDEX `NotifyLog_tenantId_sentAt_idx` ON `NotifyLog`(`tenantId`, `sentAt`);
CREATE INDEX `HouseBinding_tenantId_status_createdAt_idx` ON `HouseBinding`(`tenantId`, `status`, `createdAt`);
CREATE INDEX `Announcement_tenantId_status_pinned_publishedAt_idx` ON `Announcement`(`tenantId`, `status`, `pinned`, `publishedAt`);
