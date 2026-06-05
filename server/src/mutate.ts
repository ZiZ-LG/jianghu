import { prisma } from './prisma.js';

/** 把前端 Action 落到数据库（全程按 tenantId 隔离）。返回是否成功，失败抛错。 */
export async function applyAction(tenantId: string, action: any): Promise<void> {
  const t = action?.type as string;
  const S = (v: unknown) => JSON.stringify(v ?? null);

  // 仅挑选 patch 中存在的字段，避免覆盖为 undefined
  const pick = (patch: any, keys: string[]) => {
    const d: any = {};
    for (const k of keys) if (patch && patch[k] !== undefined) d[k] = patch[k];
    return d;
  };
  // 确认某机会属于本租户
  const assertOpp = async (oppId: string) => {
    const o = await prisma.opportunity.findFirst({ where: { id: oppId, tenantId }, select: { id: true } });
    if (!o) throw new Error('opportunity not found');
  };

  switch (t) {
    case 'ADD_ACCOUNT': {
      const a = action.account;
      await prisma.account.create({ data: {
        id: a.id, tenantId, name: a.name, customerType: a.customerType, unifiedCreditCode: a.unifiedCreditCode ?? null,
        externalRef: a.externalRef ?? null, region: a.region ?? '', group: a.group ?? '', primaryOwner: a.primaryOwner ?? '',
        profile: S(a.profile ?? {}),
      } });
      return;
    }
    case 'UPDATE_ACCOUNT': {
      const d = pick(action.patch, ['name', 'customerType', 'unifiedCreditCode', 'externalRef', 'region', 'group', 'primaryOwner']);
      if (action.patch?.profile !== undefined) d.profile = S(action.patch.profile);
      await prisma.account.updateMany({ where: { id: action.accId, tenantId }, data: d });
      return;
    }
    case 'DELETE_ACCOUNT':
      await prisma.account.deleteMany({ where: { id: action.accId, tenantId } });
      return;

    case 'ADD_OPP': {
      const o = action.opp;
      await prisma.opportunity.create({ data: {
        id: o.id, tenantId, accountId: action.accId, name: o.name, customerType: o.customerType,
        pipelineStage: o.pipelineStage, engageStage: o.engageStage, changeMode: o.changeMode ?? null,
        singleSalesGoal: o.singleSalesGoal ?? '', customerBusinessGoal: o.customerBusinessGoal ?? null,
        buyingMotivation: o.buyingMotivation ?? null, c3Items: S(o.c3Items ?? {}), c5Items: S(o.c5Items ?? {}),
      } });
      return;
    }
    case 'UPDATE_OPP': {
      const d = pick(action.patch, ['name', 'pipelineStage', 'engageStage', 'changeMode', 'singleSalesGoal', 'customerBusinessGoal', 'buyingMotivation']);
      if (action.patch?.c3Items !== undefined) d.c3Items = S(action.patch.c3Items);
      if (action.patch?.c5Items !== undefined) d.c5Items = S(action.patch.c5Items);
      await prisma.opportunity.updateMany({ where: { id: action.oppId, tenantId }, data: d });
      return;
    }
    case 'DELETE_OPP':
      await prisma.opportunity.deleteMany({ where: { id: action.oppId, tenantId } });
      return;

    case 'ADD_PERSON': {
      const p = action.person;
      await prisma.person.create({ data: {
        id: p.id, tenantId, accountId: action.accId, name: p.name, title: p.title, orgLevel: p.orgLevel ?? 3,
        isCompetitor: !!p.isCompetitor, avatarUrl: p.avatarUrl ?? null, coachLevel: p.coachLevel ?? null,
        x: p.x ?? 300, y: p.y ?? 240, form: S(p.form ?? {}), logs: S(p.logs ?? []),
      } });
      return;
    }
    case 'UPDATE_PERSON': {
      const d = pick(action.patch, ['name', 'title', 'orgLevel', 'avatarUrl', 'coachLevel', 'color']);
      if (action.patch?.form !== undefined) d.form = S(action.patch.form);
      if (action.patch?.logs !== undefined) d.logs = S(action.patch.logs);
      await prisma.person.updateMany({ where: { id: action.personId, tenantId }, data: d });
      return;
    }
    case 'MOVE_PERSON':
      await prisma.person.updateMany({ where: { id: action.personId, tenantId }, data: { x: action.x, y: action.y } });
      return;
    case 'DELETE_PERSON': {
      const pid = action.personId;
      const bis = await prisma.burningIssue.findMany({ where: { personId: pid, tenantId }, select: { id: true } });
      const biIds = bis.map((b) => b.id);
      await prisma.uCV.deleteMany({ where: { tenantId, targetBiId: { in: biIds } } });
      await prisma.burningIssue.deleteMany({ where: { personId: pid, tenantId } });
      await prisma.oppRole.deleteMany({ where: { personId: pid, tenantId } });
      await prisma.edge.deleteMany({ where: { tenantId, OR: [{ source: pid }, { target: pid }] } });
      await prisma.person.deleteMany({ where: { id: pid, tenantId } });
      return;
    }
    case 'ADD_LOG': {
      const person = await prisma.person.findFirst({ where: { id: action.personId, tenantId } });
      if (!person) throw new Error('person not found');
      const logs = (() => { try { return JSON.parse(person.logs); } catch { return []; } })();
      await prisma.person.updateMany({ where: { id: action.personId, tenantId }, data: { logs: S([action.log, ...logs]) } });
      return;
    }

    case 'SET_ROLE': {
      await assertOpp(action.oppId);
      const p = action.patch ?? {};
      await prisma.oppRole.upsert({
        where: { opportunityId_personId: { opportunityId: action.oppId, personId: action.personId } },
        create: {
          tenantId, opportunityId: action.oppId, personId: action.personId,
          role: p.role ?? 'U', sentiment: p.sentiment ?? 'unknown', confidence: p.confidence ?? '推理',
          sentimentValue: p.sentimentValue ?? null, isKeyInfluencer: !!p.isKeyInfluencer,
          procurementType: p.procurementType ?? null, procurementStatus: p.procurementStatus ?? null,
        },
        update: pick(p, ['role', 'sentiment', 'sentimentValue', 'confidence', 'isKeyInfluencer', 'procurementType', 'procurementStatus']),
      });
      return;
    }
    case 'REMOVE_ROLE':
      await prisma.oppRole.deleteMany({ where: { tenantId, opportunityId: action.oppId, personId: action.personId } });
      return;

    case 'ADD_EDGE': {
      const e = action.edge;
      await prisma.edge.create({ data: {
        id: e.id, tenantId, accountId: action.accId, opportunityId: action.oppId ?? null,
        source: e.source, target: e.target, layer: e.layer, label: e.label,
        color: e.color ?? null, style: e.style ?? null, width: e.width ?? null, directed: !!e.directed, origin: e.origin ?? 'manual',
        shape: e.shape ?? null, bend: e.bend ?? null,
      } });
      return;
    }
    case 'UPDATE_EDGE':
      // 端点改接(source/target)+外观(label/color/style/width/directed/layer)+形状(shape/bend)，全程租户隔离
      await prisma.edge.updateMany({
        where: { id: action.edgeId, tenantId },
        data: pick(action.patch, ['source', 'target', 'layer', 'label', 'color', 'style', 'width', 'directed', 'shape', 'bend']),
      });
      return;
    case 'DELETE_EDGE':
      await prisma.edge.deleteMany({ where: { id: action.edgeId, tenantId } });
      return;

    case 'ADD_BI': {
      const b = action.bi;
      await prisma.burningIssue.create({ data: { id: b.id, tenantId, opportunityId: action.oppId, personId: b.personId, description: b.description ?? '', category: b.category ?? '其他', isPrivate: b.isPrivate ?? true, confidence: b.confidence ?? '推理' } });
      return;
    }
    case 'UPDATE_BI':
      await prisma.burningIssue.updateMany({ where: { id: action.biId, tenantId }, data: pick(action.patch, ['description', 'category', 'isPrivate', 'confidence']) });
      return;
    case 'DELETE_BI':
      await prisma.uCV.deleteMany({ where: { tenantId, targetBiId: action.biId } });
      await prisma.burningIssue.deleteMany({ where: { id: action.biId, tenantId } });
      return;

    case 'ADD_UCV': {
      const u = action.ucv;
      await prisma.uCV.create({ data: { id: u.id, tenantId, opportunityId: action.oppId, targetBiId: u.targetBiId, description: u.description ?? '', competitorCannot: u.competitorCannot ?? '', status: u.status ?? '建议' } });
      return;
    }
    case 'UPDATE_UCV':
      await prisma.uCV.updateMany({ where: { id: action.ucvId, tenantId }, data: pick(action.patch, ['description', 'competitorCannot', 'status', 'targetBiId']) });
      return;
    case 'DELETE_UCV':
      await prisma.uCV.deleteMany({ where: { id: action.ucvId, tenantId } });
      return;

    default:
      throw new Error(`unknown action: ${t}`);
  }
}
