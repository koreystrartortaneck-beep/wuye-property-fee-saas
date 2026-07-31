-- Bill.paymentId 唯一约束（资金侧兜底）
--
-- 当前模型是「单账单单支付」：createPayment 明确拒绝数组入参，
-- payment.service 与 offline-payment.service 两处写入都是按 id 单条更新 + count 校验。
-- 加唯一索引后，万一将来有代码把两张账单指向同一笔支付，会在写入时立刻失败，
-- 而不是静默产生「一笔钱销两张账单」的脏数据。
--
-- 可空列的唯一索引在 MySQL 允许多个 NULL，因此大量未支付账单（paymentId IS NULL）不受影响。
-- 上线前已核对生产数据：24 张账单、7 个非空 paymentId 全部一对一，不存在重复。
CREATE UNIQUE INDEX `Bill_paymentId_key` ON `Bill`(`paymentId`);
