-- 自动发券规则(null = 自领)。纯增量可空列,在线安全。
ALTER TABLE `Coupon` ADD COLUMN `autoGrant` JSON NULL;
