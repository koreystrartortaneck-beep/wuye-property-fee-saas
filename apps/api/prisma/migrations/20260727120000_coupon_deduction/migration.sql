-- 优惠券抵扣：纯新增可空列，向后兼容，不改动任何既有数据。
-- discountAmount 记券面额，Payment.totalAmount 保持为业主实付金额，
-- 二者之和等于账单原额；userCouponId 唯一，保证一张券只能用于一笔支付。
ALTER TABLE `Payment`
  ADD COLUMN `discountAmount` DECIMAL(12,2) NULL,
  ADD COLUMN `userCouponId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `Payment_userCouponId_key` ON `Payment`(`userCouponId`);
