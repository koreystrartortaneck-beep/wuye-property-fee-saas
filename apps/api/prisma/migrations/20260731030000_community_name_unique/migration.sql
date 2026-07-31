-- 同一物业公司内小区名不得重复
--
-- 起因：House 有 @@unique([communityId, code]) 防重复房号，而 Community.name 没有任何约束。
-- 审计时用同名「金港城」建小区成功返回 code:0——业主端搜索（只按 name contains 过滤）
-- 会看到两个一模一样的小区，业主选错就绑到空小区去，物业还得人工发现。
--
-- 上线前已核对生产数据：清理掉审计遗留的那条后，小区名无重复。
CREATE UNIQUE INDEX `Community_tenantId_name_key` ON `Community`(`tenantId`, `name`);
