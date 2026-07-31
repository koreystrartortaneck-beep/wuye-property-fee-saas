import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 校验 communityId 属于当前物业公司。
 *
 * 为什么需要：管理端有 6 个写入口直接把请求体里的 communityId 存进库，从不校验它存在。
 * prisma.t 保证新行的 tenantId 正确，但**不保证它引用的小区也是本公司的**。
 *
 * 后果全都是「静默什么都没发生」，而这类问题最难排查 ——
 * 界面没报错，物业以为配好了：
 *   · 费用规则 → 出账时 0 户，物业反复点「生成」找不出原因
 *   · 房屋批量导入 → 房屋挂到别家的小区，本公司列表里永远看不到
 *   · 公告 / 卡券 / 生活服务 → 范围指向不存在的小区，业主永远看不到
 *
 * 现实路径不只是「手填错」：SUPER_ADMIN 可以切换租户，
 * 浏览器里留着上一个租户的小区列表、切完租户再提交，就是跨租户引用。
 *
 * null 是合法值，表示「公司全部小区」—— 公告/卡券/生活服务都用它，不能一并拦掉。
 */
export async function assertCommunityInTenant(
  prisma: PrismaService,
  communityId: string | null | undefined,
): Promise<void> {
  if (communityId === null || communityId === undefined || communityId === '') return;
  // 用 prisma.t：租户条件由扩展注入，跨租户的 id 自然查不到
  const found = await prisma.t.community.findFirst({
    where: { id: communityId },
    select: { id: true },
  });
  if (!found) {
    throw new BizException(ErrorCode.NOT_FOUND, '小区不存在或不属于当前物业公司');
  }
}
