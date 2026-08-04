import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { ErrorCode, HOUSE_TYPES, HouseType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { normalizePhone } from '../auth/auth.service';
import { BindingSyncService } from '../binding/binding-sync.service';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { AuditService } from '../audit/audit.service';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { assertCommunityInTenant } from './community-scope';
import { PrismaService } from '../prisma/prisma.service';

class HouseRowDto {
  @IsIn(HOUSE_TYPES as unknown as string[])
  type!: HouseType;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  building?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  room?: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  code!: string;

  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  displayName!: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  area?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ownerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerPhone?: string;

  /*
   * 授权手机号列表,分号分隔("13800001111;13900002222")。
   * 与 ownerPhone 合并后统一写进 HouseContact —— legacy 单号列继续可用,
   * 新表格可以一行导入多个授权人(业主+租客)。
   * 191 上限≈15 个号:这不是数据库列(拆开落 HouseContact),
   * 但 input-limits 守卫按「所有 DTO 字段≤191」统一钉,遵守它比开豁免干净。
   */
  @IsOptional()
  @IsString()
  @MaxLength(191)
  contactPhones?: string;

  /*
   * 放户日期(YYYY-MM-DD)—— 按户周年账期的锚点。
   * 字符串进、服务端转 Date:Excel 里就是文本列,让物业照抄不做格式转换。
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '放户日期格式须为 YYYY-MM-DD' })
  handoverDate?: string;

  /** 挂接的收费标准代号,分号分隔("WYF-ZZ;CKF")。未知代号 = 行失败并说明 */
  @IsOptional()
  @IsString()
  @MaxLength(191)
  standardCodes?: string;
}

class ImportHousesDto {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  /*
   * 行数上限。原先没有任何限制，只被 Express 默认 100KB 的 body 限制间接卡在约
   * 600 行——超过就返回 413，物业看到的是一个无法理解的错误而不是业务提示。
   * 2000 行覆盖一栋楼到一个中型小区，且批量化改造后写入耗时可控。
   */
  @IsArray()
  @ArrayMaxSize(2000, { message: '单次最多导入 2000 行，请拆分文件' })
  @ValidateNested({ each: true })
  @Type(() => HouseRowDto)
  rows!: HouseRowDto[];
}

class ListHousesQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(HOUSE_TYPES as unknown as string[])
  type?: HouseType;

  @IsOptional()
  @IsString()
  keyword?: string;
}

class UpdateHouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  area?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ownerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerPhone?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '放户日期格式须为 YYYY-MM-DD' })
  handoverDate?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Injectable()
export class HousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bindingSync: BindingSyncService,
  ) {}

  /** 行数据 → House 列:剥掉传输字段(联系人/标准代号),放户日期转 Date */
  private rowToHouseData(row: HouseRowDto): Record<string, unknown> {
    const { contactPhones: _cp, standardCodes: _sc, handoverDate, ...rest } = row;
    return {
      ...rest,
      // UTC 午夜:对 UTC/东八区进程都落在同一个日历日(@db.Date 只存日期部分)
      ...(handoverDate ? { handoverDate: new Date(`${handoverDate}T00:00:00Z`) } : {}),
    };
  }

  /** 单行业务校验：住宅必须有面积 */
  private validateRow(row: HouseRowDto): string | null {
    if (row.type === 'RESIDENCE' && (row.area === undefined || row.area <= 0)) {
      return '住宅必须填写建筑面积';
    }
    return null;
  }

  /** 批量导入：唯一键 (communityId, code) upsert，逐行汇报结果 */
  async import(dto: ImportHousesDto, adminId: string) {
    /*
     * 先确认小区属于本公司再导入。
     *
     * 不校验的话，一批房屋会挂到别家公司的小区上：prisma.t 保证 tenantId 是对的，
     * 但 communityId 指向别处 —— 房屋在本公司的任何列表里都查不到（列表按小区过滤），
     * 而导入结果显示「成功 N 条」。物业会以为导好了，直到发现房屋一个都不在。
     */
    await assertCommunityInTenant(this.prisma, dto.communityId);
    let created = 0;
    let updated = 0;
    const failed: { index: number; reason: string }[] = [];

    /*
     * 一次查出已存在的房号，新增走 createMany，只有确实要改的行才逐条 update。
     *
     * 原实现每行 2-3 次数据库往返（findFirst + update/create）：
     *   600 行 → 约 1200 次 ≈ 3.6s
     *  2000 行 → 约 4000 次 ≈ 12s，请求很可能撞网关超时，而此时后台还在继续写，
     *            物业不知道到底导进去多少
     * 现在是 2 次 + 需更新的行数。
     */
    const valid: HouseRowDto[] = [];
    for (let i = 0; i < dto.rows.length; i++) {
      const reason = this.validateRow(dto.rows[i]);
      if (reason) failed.push({ index: i, reason });
      else valid.push(dto.rows[i]);
    }

    const existing = valid.length
      ? await this.prisma.t.house.findMany({
          where: { communityId: dto.communityId, code: { in: valid.map((r) => r.code) } },
          select: { id: true, code: true },
        })
      : [];
    const idByCode = new Map(existing.map((h) => [h.code, h.id]));

    const toCreate = valid.filter((r) => !idByCode.has(r.code));
    if (toCreate.length) {
      const res = await this.prisma.t.house.createMany({
        /*
         * 只对 tenantId 留类型出口 —— 它由 prisma.t 的租户扩展自动注入
         * （tenant-extension 的 injectData 对数组也逐项注入），这里不能写也不该写。
         * 不用 `as never`：那会让 Prisma 对**其余所有字段**的校验一并失效，
         * 而 createMany 是批量写，错一个字段名就是几千行脏数据。
         */
        data: toCreate.map((r) => ({ ...this.rowToHouseData(r), communityId: dto.communityId })) as Prisma.HouseCreateManyInput[],
        // 兜住 @@unique([communityId, code])：同一次导入里文件内重复的房号
        skipDuplicates: true,
      });
      created = res.count;
    }

    for (const row of valid) {
      const id = idByCode.get(row.code);
      if (!id) continue;
      try {
        await this.prisma.t.house.update({ where: { id }, data: this.rowToHouseData(row) as Prisma.HouseUpdateInput });
        updated++;
      } catch (e) {
        failed.push({
          index: dto.rows.indexOf(row),
          reason: e instanceof Error ? e.message : '未知错误',
        });
      }
    }

    const contacts = await this.importContacts(dto.communityId, valid, adminId);
    const standards = await this.importStandards(dto.communityId, valid, adminId, failed);
    return { created, updated, failed, contacts, standards };
  }

  /**
   * 导入行的 standardCodes → HouseStandard 挂接。
   * 未知代号是**行级失败**(计入 failed 并指名代号),不是静默跳过 ——
   * 物业以为挂上了、下月出账少一片,比导入当场报错难查得多。
   */
  private async importStandards(
    communityId: string,
    rows: HouseRowDto[],
    adminId: string,
    failed: { index: number; reason: string }[],
  ) {
    const wanted = rows.filter((r) => r.standardCodes?.trim());
    if (wanted.length === 0) return { attached: 0 };

    const allCodes = [...new Set(wanted.flatMap((r) => r.standardCodes!.split(/[;；]/).map((s) => s.trim()).filter(Boolean)))];
    const rules = await this.prisma.t.feeRule.findMany({
      where: { communityId, code: { in: allCodes } },
      select: { id: true, code: true },
    });
    const ruleByCode = new Map(rules.map((r) => [r.code!, r.id]));

    const houses = await this.prisma.t.house.findMany({
      where: { communityId, code: { in: wanted.map((r) => r.code) } },
      select: { id: true, code: true },
    });
    const houseByCode = new Map(houses.map((h) => [h.code, h.id]));

    const data: Array<{ houseId: string; ruleId: string; createdBy: string }> = [];
    for (const row of wanted) {
      const houseId = houseByCode.get(row.code);
      if (!houseId) continue; // 行本身失败(如缺面积)没落库,标准也不挂
      for (const code of row.standardCodes!.split(/[;；]/).map((s) => s.trim()).filter(Boolean)) {
        const ruleId = ruleByCode.get(code);
        if (!ruleId) {
          failed.push({ index: rows.indexOf(row), reason: `收费标准代号「${code}」在该小区不存在` });
          continue;
        }
        data.push({ houseId, ruleId, createdBy: adminId });
      }
    }
    if (data.length === 0) return { attached: 0 };
    const res = await this.prisma.t.houseStandard.createMany({
      data: data as Prisma.HouseStandardCreateManyInput[],
      skipDuplicates: true, // 重复导入幂等
    });
    return { attached: res.count };
  }

  /**
   * 导入的联系人落库 + 已授权用户即时绑定。
   *
   * 往返有界:重查一次房号→id 映射、一次 createMany、一次按号找用户,
   * 只有「号主已在用小程序」的少数情况才逐一 applyPhoneMatch —— 2000 行也扛得住。
   * 非法号计入 skipped 并如实返回,不静默丢(否则「导入成功」又是一句假话)。
   */
  private async importContacts(communityId: string, rows: HouseRowDto[], adminId: string) {
    const wanted: Array<{ code: string; phone: string; name: string | null }> = [];
    let invalidPhones = 0;
    for (const row of rows) {
      const raw = [row.ownerPhone ?? '', ...(row.contactPhones ?? '').split(/[;；]/)];
      for (const p of raw) {
        const phone = normalizePhone(p.trim());
        if (!phone) continue;
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          invalidPhones += 1;
          continue;
        }
        wanted.push({ code: row.code, phone, name: row.ownerName ?? null });
      }
    }
    if (wanted.length === 0) return { added: 0, activatedBindings: 0, invalidPhones };

    const houses = await this.prisma.t.house.findMany({
      where: { communityId, code: { in: [...new Set(wanted.map((c) => c.code))] } },
      select: { id: true, tenantId: true, communityId: true, code: true },
    });
    const houseByCode = new Map(houses.map((h) => [h.code, h]));

    const data = wanted
      .map((c) => {
        const house = houseByCode.get(c.code);
        return house ? { houseId: house.id, phone: c.phone, name: c.name, source: 'IMPORT' as const, createdBy: adminId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const res = await this.prisma.t.houseContact.createMany({
      data: data as Prisma.HouseContactCreateManyInput[],
      skipDuplicates: true, // (houseId, phone) 已存在 → 幂等跳过,重复导入不炸
    });

    // 已在用小程序的号主当场绑上;没用过的等他授权那刻由 bindPhone 兜住
    const phones = [...new Set(data.map((d) => d.phone))];
    const users = await this.prisma.raw.wxUser.findMany({
      where: { phone: { in: phones }, deletedAt: null },
      select: { id: true, phone: true },
    });
    let activated = 0;
    const now = new Date();
    const houseById = new Map(houses.map((h) => [h.id, h]));
    const housesByPhone = new Map<string, typeof houses>();
    for (const d of data) {
      const house = houseById.get(d.houseId);
      if (!house) continue;
      const list = housesByPhone.get(d.phone) ?? [];
      if (!list.some((h) => h.id === house.id)) list.push(house);
      housesByPhone.set(d.phone, list);
    }
    for (const u of users) {
      const hs = housesByPhone.get(u.phone!) ?? [];
      if (hs.length === 0) continue;
      activated += await this.bindingSync.applyPhoneMatch(this.prisma.raw, u.id, hs, now, { type: 'ADMIN', id: adminId });
    }
    return { added: res.count, activatedBindings: activated, invalidPhones };
  }

  async list(q: ListHousesQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.keyword
        ? { OR: [{ code: { contains: q.keyword } }, { displayName: { contains: q.keyword } }, { ownerName: { contains: q.keyword } }, { ownerPhone: { contains: q.keyword } }] }
        : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.house.findMany({ where, ...pageArgs(q), orderBy: { code: 'asc' } }),
      this.prisma.t.house.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  async update(id: string, dto: UpdateHouseDto, adminId: string) {
    /*
     * ownerPhone 的变更必须联动绑定 —— 这正是本次重构修的核心 bug:
     * 原来这里是一行裸 update,后台把手机号从旧住户改成新住户,
     * 旧住户的绑定原封不动,换租后他继续看得到新住户的账单。
     *
     * 语义:改号 = 删旧号 + 加新号(与联系人操作同一份实现);
     * 旧号的绑定立即撤销,新号的用户立即绑上。
     * ownerPhone 列处于冻结期,仍随之同步,保证欠费导出等旧读路径的数据不断档;
     * P4 后台改用联系人列表后,这条桥保持兼容直至删列。
     */
    // handoverDate 走字符串进(前端/DTO 层),落库前转 Date(@db.Date 只存日期部分)
    const data: Record<string, unknown> = {
      ...dto,
      ...(dto.handoverDate ? { handoverDate: new Date(`${dto.handoverDate}T00:00:00Z`) } : {}),
    };

    /*
     * 改房屋必须留审计 —— 这里原来一条都不写。
     *
     * 2026-08-04 实测:一套房的 displayName 被改成了「03-13」,而我翻遍审计
     * 一条 House 的 UPDATE 都找不到 —— 无从判断是界面写错了、还是人手打的。
     * 而这一页能改的两个字段(面积、放户日期)直接决定账单金额与出账月份:
     * 「这户为什么突然多收了 500」只能靠这段历史回答。
     */
    const before = await this.prisma.t.house.findFirst({
      where: { id },
      select: {
        id: true, tenantId: true, communityId: true, code: true,
        displayName: true, area: true, handoverDate: true, status: true, ownerName: true, ownerPhone: true,
      },
    });
    if (!before) throw new BizException(ErrorCode.NOT_FOUND, '房屋不存在或不属于当前物业公司');
    // 只记真变了的字段:全字段回写会让审计里堆满假变更,真正改过面积那一次就淹了
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    const norm = (v: unknown) =>
      v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    for (const key of ['displayName', 'area', 'handoverDate', 'status', 'ownerName'] as const) {
      if (dto[key] === undefined) continue;
      const from = norm((before as Record<string, unknown>)[key]);
      const to = norm(key === 'handoverDate' ? dto.handoverDate : dto[key]);
      if (from !== to) changed[key] = { from, to };
    }
    // 手机号只记「改了没」,不进审计正文 —— 审计脱敏会把号码打码,记了也没用
    if (dto.ownerPhone !== undefined && (dto.ownerPhone ?? null) !== (before.ownerPhone ?? null)) {
      changed.ownerPhoneChanged = { from: !!before.ownerPhone, to: !!dto.ownerPhone };
    }
    const writeAudit = async (tx?: Parameters<typeof this.audit.append>[1]) => {
      if (Object.keys(changed).length === 0) return;
      await this.audit.append(
        {
          tenantId: before.tenantId,
          communityId: before.communityId,
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'UPDATE',
          resourceType: 'House',
          resourceId: id,
          beforeSummary: { code: before.code, changed },
          afterSummary: { event: 'HOUSE_UPDATE', fields: Object.keys(changed) },
        },
        tx,
      );
    };

    if (dto.ownerPhone === undefined) {
      const updated = await this.prisma.t.house.update({ where: { id }, data: data as Prisma.HouseUpdateInput });
      await writeAudit();
      return updated;
    }
    const house = before;

    const newPhone = dto.ownerPhone ? normalizePhone(dto.ownerPhone) : null;
    if (newPhone) this.bindingSync.assertMobile(newPhone);
    const oldPhone = house.ownerPhone ? normalizePhone(house.ownerPhone) : null;
    const actor = { type: 'ADMIN' as const, id: adminId };

    return this.prisma.raw.$transaction(async (tx) => {
      if (oldPhone && oldPhone !== newPhone) {
        await this.bindingSync.revokeContact(tx, house, oldPhone, '物业已变更房屋登记手机号', actor);
      }
      if (newPhone && newPhone !== oldPhone) {
        await this.bindingSync.grantContact(tx, house, newPhone, dto.ownerName ?? null, 'ADMIN', actor);
      }
      const updated = await tx.house.update({
        where: { id },
        data: { ...data, ownerPhone: newPhone } as Prisma.HouseUpdateInput,
      });
      await writeAudit(tx);
      return updated;
    });
  }

  /*
   * 房屋原来只能导入和停用，**删不掉**。
   *
   * 导错一批（房号规则搞错、导到了错的小区、试用期造的测试数据）之后，
   * 唯一的补救是把它们停用 —— 于是错误数据永久留在库里：
   * 后台房屋列表里躺着，导入时和正确的房号撞唯一键，删小区也被它们挡住
   * （删小区要求下面没有房屋，而房屋删不掉 → 小区也永远删不掉）。
   *
   * 停用不是删除。停用的语义是「这套房还在，只是暂时不收费」，
   * 而导错的那行根本不该存在。
   *
   * 与删小区同样的思路：有任何业务数据挂着就拒绝，并说清挂着什么。
   * 这里不做级联 —— 一个删除动作顺手删掉账单和缴费记录是不可接受的。
   */
  private static readonly BLOCKING: Array<[string, string]> = [
    ['bill', '账单'],
    ['houseBinding', '业主绑定'],
    ['ticket', '工单'],
    ['visitorPass', '访客通行码'],
    ['serviceOrder', '服务预约'],
  ];

  async remove(id: string, adminId: string) {
    const house = await this.prisma.t.house.findFirst({
      where: { id },
      select: { id: true, code: true, displayName: true, communityId: true, tenantId: true },
    });
    if (!house) throw new BizException(ErrorCode.NOT_FOUND, '房屋不存在或不属于当前物业公司');

    const client = this.prisma.t as unknown as Record<string, { count(args: unknown): Promise<number> }>;
    const attached: string[] = [];
    for (const [model, label] of HousesService.BLOCKING) {
      const n = await client[model].count({ where: { houseId: id } });
      if (n > 0) attached.push(`${label} ${n} 条`);
    }
    if (attached.length > 0) {
      throw new BizException(
        ErrorCode.VALIDATION,
        `「${house.displayName}」下还有 ${attached.join('、')}，不能删除。` +
          `请先处理这些数据，或把该房屋改为停用。`,
      );
    }

    /*
     * 联系人随房删除,不进挡板清单 —— 深思后的取舍:
     * 联系人是「授权配置」不是业务历史(账单/绑定才是),把它加进挡板
     * 会让「导错一批带手机号的房」变成删不掉的垃圾 —— 正是前天刚修过的那种死结。
     * 加号/删号的审计留着,删了多少条也写进本次审计。
     * (绑定仍然挡:有人绑着说明有人在用,那不是配置是状态。)
     */
    const removedContacts = await this.prisma.t.houseContact.deleteMany({ where: { houseId: id } });
    await this.prisma.t.house.delete({ where: { id } });
    /*
     * 删除必须留痕。房屋是计费的根，删掉之后再想追「这户去哪了」，
     * 除了审计没有任何地方查得到。
     */
    await this.audit.append({
      tenantId: house.tenantId,
      communityId: house.communityId,
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'DELETE',
      resourceType: 'House',
      resourceId: id,
      // 房号比 cuid 有用：查审计的人认得房号
      beforeSummary: { code: house.code, displayName: house.displayName },
      afterSummary: { event: 'HOUSE_DELETE', removedContacts: removedContacts.count },
    });
    return { deleted: true, code: house.code };
  }
}

@Controller('admin/houses')
@UseGuards(AdminGuard, RolesGuard)
export class HousesController {
  constructor(private readonly service: HousesService) {}

  @Post('import')
  import(@Current() cur: CurrentAdmin, @Body() dto: ImportHousesDto) {
    return this.service.import(dto, cur.adminId);
  }

  @Get()
  list(@Query() q: ListHousesQuery) {
    return this.service.list(q);
  }

  @Patch(':id')
  update(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: UpdateHouseDto) {
    return this.service.update(id, dto, cur.adminId);
  }

  /*
   * 与删小区同级：只有 TENANT_ADMIN 能删。
   * 误删的代价（哪怕有挂载校验兜着）不该由一个日常操作角色承担。
   */
  @Roles('TENANT_ADMIN')
  @Delete(':id')
  remove(@Current() cur: CurrentAdmin, @Param('id') id: string) {
    return this.service.remove(id, cur.adminId);
  }
}
