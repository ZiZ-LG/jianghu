import { prisma } from './prisma.js';

/** 乐观锁冲突：目标实体 version 与客户端 baseVersion 不一致（他人已先改）。index.ts 据此回 409。 */
class ConflictError extends Error {
  readonly conflict = true;
  constructor(msg = '该数据已被其他成员修改，请刷新后重试') { super(msg); }
}

/**
 * 乐观锁 update：带 baseVersion 时按 version 匹配写入并自增；未命中再区分「版本冲突」与「记录不存在」。
 * - baseVersion 缺省（旧客户端 / 非关键路径）：不校验，仍自增 version 保持单调，便于并发方感知变化。
 * - 命中 0 行且记录仍在 → 版本已被他人改过 → 抛 ConflictError（→ 409）。
 * - 命中 0 行且记录已不在 → 删除竞争，静默（前端重拉即一致）。
 */
async function lockedUpdate(opts: {
  baseVersion?: number;
  update: (versionWhere: { version?: number }) => Promise<{ count: number }>;
  exists: () => Promise<boolean>;
}): Promise<void> {
  const { baseVersion, update, exists } = opts;
  if (baseVersion === undefined || baseVersion === null) { await update({}); return; }
  const r = await update({ version: baseVersion });
  if (r.count === 0 && (await exists())) throw new ConflictError();
}

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
        externalRef: o.externalRef ?? null, status: o.status ?? 'active', productSolution: o.productSolution ?? '',
        competitor: o.competitor ?? '', competitiveSituation: o.competitiveSituation ?? '',
        winProbability: o.winProbability ?? 0, expectedSignDate: o.expectedSignDate ?? '',
        expectedAmountW: o.expectedAmountW ?? 0, meta: S(o.meta ?? {}),
        memberScoped: o.memberScoped ?? false,
      } });
      return;
    }
    case 'UPDATE_OPP': {
      const d = pick(action.patch, ['name', 'pipelineStage', 'engageStage', 'changeMode', 'singleSalesGoal', 'customerBusinessGoal', 'buyingMotivation', 'externalRef', 'status', 'productSolution', 'competitor', 'competitiveSituation', 'winProbability', 'expectedSignDate', 'expectedAmountW']);
      if (action.patch?.c3Items !== undefined) d.c3Items = S(action.patch.c3Items);
      if (action.patch?.c5Items !== undefined) d.c5Items = S(action.patch.c5Items);
      if (action.patch?.meta !== undefined) d.meta = S(action.patch.meta);
      await lockedUpdate({
        baseVersion: action.baseVersion,
        update: (vw) => prisma.opportunity.updateMany({ where: { id: action.oppId, tenantId, ...vw }, data: { ...d, version: { increment: 1 } } }),
        exists: async () => !!(await prisma.opportunity.findFirst({ where: { id: action.oppId, tenantId }, select: { id: true } })),
      });
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
      await lockedUpdate({
        baseVersion: action.baseVersion,
        update: (vw) => prisma.person.updateMany({ where: { id: action.personId, tenantId, ...vw }, data: { ...d, version: { increment: 1 } } }),
        exists: async () => !!(await prisma.person.findFirst({ where: { id: action.personId, tenantId }, select: { id: true } })),
      });
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
      await prisma.opportunityMember.deleteMany({ where: { personId: pid, tenantId } });
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
          assessedAt: new Date(), // PDE 立场评估时点（时间衰减基准，裁决B：OppRole 承载）
        },
        update: {
          ...pick(p, ['role', 'sentiment', 'sentimentValue', 'confidence', 'isKeyInfluencer', 'procurementType', 'procurementStatus']),
          // 改了态度或可信度 = 一次新的立场评估 → 刷新衰减基准
          ...('sentiment' in p || 'confidence' in p ? { assessedAt: new Date() } : {}),
        },
      });
      return;
    }
    case 'REMOVE_ROLE':
      await prisma.oppRole.deleteMany({ where: { tenantId, opportunityId: action.oppId, personId: action.personId } });
      return;

    case 'ADD_OPP_MEMBER':
      await prisma.opportunityMember.upsert({
        where: { opportunityId_personId: { opportunityId: action.oppId, personId: action.personId } },
        create: { tenantId, opportunityId: action.oppId, personId: action.personId },
        update: {},
      });
      return;
    case 'REMOVE_OPP_MEMBER':
      await prisma.opportunityMember.deleteMany({ where: { tenantId, opportunityId: action.oppId, personId: action.personId } });
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
    case 'UPDATE_EDGE': {
      // 端点改接(source/target)+外观(label/color/style/width/directed/layer)+形状(shape/bend)，全程租户隔离 + 乐观锁
      const d = pick(action.patch, ['source', 'target', 'layer', 'label', 'color', 'style', 'width', 'directed', 'shape', 'bend']);
      await lockedUpdate({
        baseVersion: action.baseVersion,
        update: (vw) => prisma.edge.updateMany({ where: { id: action.edgeId, tenantId, ...vw }, data: { ...d, version: { increment: 1 } } }),
        exists: async () => !!(await prisma.edge.findFirst({ where: { id: action.edgeId, tenantId }, select: { id: true } })),
      });
      return;
    }
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

    case 'ADD_VISIT': {
      const v = action.visit;
      await prisma.visitNote.create({ data: {
        id: v.id, tenantId, accountId: action.accId, opportunityId: v.opportunityId ?? null,
        externalRef: v.externalRef ?? null, date: v.date ?? '', topic: v.topic ?? '', summary: v.summary ?? '',
        participants: S(v.participants ?? []), origin: v.origin ?? 'workbuddy', createdBy: v.createdBy ?? '',
      } });
      return;
    }
    case 'UPDATE_VISIT': {
      const d = pick(action.patch, ['opportunityId', 'externalRef', 'date', 'topic', 'summary', 'origin']);
      if (action.patch?.participants !== undefined) d.participants = S(action.patch.participants);
      await prisma.visitNote.updateMany({ where: { id: action.visitId, tenantId }, data: d });
      return;
    }
    case 'DELETE_VISIT':
      await prisma.visitNote.deleteMany({ where: { id: action.visitId, tenantId } });
      return;

    // ── 自由文本层 · 通用笔记（Note，挂载对象可空）──
    case 'ADD_NOTE': {
      const n = action.note;
      await prisma.note.create({ data: {
        id: n.id, tenantId, accountId: n.accountId ?? null, opportunityId: n.opportunityId ?? null,
        personId: n.personId ?? null, content: n.content ?? '', source: n.source ?? 'manual',
        tags: S(n.tags ?? []), createdBy: n.createdBy ?? '',
      } });
      return;
    }
    case 'UPDATE_NOTE': {
      const d = pick(action.patch, ['accountId', 'opportunityId', 'personId', 'content', 'source']);
      if (action.patch?.tags !== undefined) d.tags = S(action.patch.tags);
      await prisma.note.updateMany({ where: { id: action.noteId, tenantId }, data: d });
      return;
    }
    case 'DELETE_NOTE':
      await prisma.note.deleteMany({ where: { id: action.noteId, tenantId } });
      return;

    // ── 商机策划 · 行动计划（PlanAction）──
    case 'ADD_PLAN_ACTION': {
      await assertOpp(action.oppId);
      const a = action.planAction;
      await prisma.planAction.create({ data: {
        id: a.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        gapItem: a.gapItem ?? '', personId: a.personId ?? null, title: a.title ?? '',
        scene: a.scene ?? '', scripts: a.scripts ?? '', target: a.target ?? '', ownerId: a.ownerId ?? '',
        startDate: a.startDate ?? '', endDate: a.endDate ?? '', half: a.half ?? 'am',
        done: !!a.done, doneAt: a.doneAt ?? null, draft: !!a.draft, review: a.review ?? '', origin: a.origin ?? 'manual', createdBy: a.createdBy ?? '',
        resources: a.resources ?? '', cautions: a.cautions ?? '', props: a.props ?? '',
      } });
      return;
    }
    case 'UPDATE_PLAN_ACTION': {
      const d = pick(action.patch, ['gapItem', 'personId', 'title', 'scene', 'scripts', 'target', 'ownerId', 'startDate', 'endDate', 'half', 'done', 'doneAt', 'draft', 'review', 'resources', 'cautions', 'props']);
      await prisma.planAction.updateMany({ where: { id: action.actionId, tenantId }, data: d });
      return;
    }
    case 'DELETE_PLAN_ACTION':
      await prisma.planAction.deleteMany({ where: { id: action.actionId, tenantId } });
      return;
    case 'TOGGLE_PLAN_ACTION':
      await prisma.planAction.updateMany({
        where: { id: action.actionId, tenantId },
        data: { done: !!action.done, doneAt: action.done ? (action.doneAt ?? new Date().toISOString().slice(0, 10)) : null },
      });
      return;

    // ── 商机策划 · 里程碑（OppMilestone）──
    case 'ADD_MILESTONE': {
      await assertOpp(action.oppId);
      const m = action.milestone;
      await prisma.oppMilestone.create({ data: {
        id: m.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        title: m.title ?? '', startDate: m.startDate ?? '', endDate: m.endDate ?? '', half: m.half ?? 'am',
      } });
      return;
    }
    case 'UPDATE_MILESTONE': {
      const d = pick(action.patch, ['title', 'startDate', 'endDate', 'half']);
      await prisma.oppMilestone.updateMany({ where: { id: action.milestoneId, tenantId }, data: d });
      return;
    }
    case 'DELETE_MILESTONE':
      await prisma.oppMilestone.deleteMany({ where: { id: action.milestoneId, tenantId } });
      return;

    // ── 商机策划 · 阶段段（OppStage，年视图模型 B）──
    case 'ADD_OPP_STAGE': {
      await assertOpp(action.oppId);
      const s = action.stage;
      await prisma.oppStage.create({ data: {
        id: s.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        stageKey: s.stageKey ?? '', startDate: s.startDate ?? '', endDate: s.endDate ?? '',
      } });
      return;
    }
    case 'UPDATE_OPP_STAGE': {
      const d = pick(action.patch, ['stageKey', 'startDate', 'endDate']);
      await prisma.oppStage.updateMany({ where: { id: action.stageId, tenantId }, data: d });
      return;
    }
    case 'DELETE_OPP_STAGE':
      await prisma.oppStage.deleteMany({ where: { id: action.stageId, tenantId } });
      return;

    // ── 策略沙盘 · 策略卡（StrategyCard）──
    case 'ADD_STRATEGY_CARD': {
      await assertOpp(action.oppId);
      const c = action.card;
      await prisma.strategyCard.create({ data: {
        id: c.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        gapItem: c.gapItem ?? '', title: c.title ?? '', basis: c.basis ?? '', alternatives: c.alternatives ?? '',
        personId: c.personId ?? null, status: c.status ?? 'active', origin: c.origin ?? 'manual',
        orderIndex: c.orderIndex ?? 0, dispatchedActionIds: S(c.dispatchedActionIds ?? []),
      } });
      return;
    }
    case 'UPDATE_STRATEGY_CARD': {
      const d = pick(action.patch, ['gapItem', 'title', 'basis', 'alternatives', 'personId', 'status', 'origin', 'orderIndex']);
      if (action.patch?.dispatchedActionIds !== undefined) d.dispatchedActionIds = S(action.patch.dispatchedActionIds);
      await prisma.strategyCard.updateMany({ where: { id: action.cardId, tenantId }, data: d });
      return;
    }
    case 'DELETE_STRATEGY_CARD':
      await prisma.strategyCard.deleteMany({ where: { id: action.cardId, tenantId } });
      return;

    // ── 策略沙盘 · 风险/假设（StrategyRisk）──
    case 'ADD_STRATEGY_RISK': {
      await assertOpp(action.oppId);
      const r = action.risk;
      await prisma.strategyRisk.create({ data: {
        id: r.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        kind: r.kind ?? 'risk', text: r.text ?? '', severity: r.severity ?? 'mid',
        mitigation: r.mitigation ?? '', status: r.status ?? 'open', origin: r.origin ?? 'manual',
      } });
      return;
    }
    case 'UPDATE_STRATEGY_RISK': {
      const d = pick(action.patch, ['kind', 'text', 'severity', 'mitigation', 'status', 'origin']);
      await prisma.strategyRisk.updateMany({ where: { id: action.riskId, tenantId }, data: d });
      return;
    }
    case 'DELETE_STRATEGY_RISK':
      await prisma.strategyRisk.deleteMany({ where: { id: action.riskId, tenantId } });
      return;

    // ── 策略沙盘 · 轻量弹药（StrategyResource）──
    case 'ADD_STRATEGY_RESOURCE': {
      await assertOpp(action.oppId);
      const x = action.resource;
      await prisma.strategyResource.create({ data: {
        id: x.id, tenantId, accountId: action.accId, opportunityId: action.oppId,
        label: x.label ?? '', kind: x.kind ?? '', note: x.note ?? '',
      } });
      return;
    }
    case 'UPDATE_STRATEGY_RESOURCE': {
      const d = pick(action.patch, ['label', 'kind', 'note']);
      await prisma.strategyResource.updateMany({ where: { id: action.resourceId, tenantId }, data: d });
      return;
    }
    case 'DELETE_STRATEGY_RESOURCE':
      await prisma.strategyResource.deleteMany({ where: { id: action.resourceId, tenantId } });
      return;

    case 'ADD_EVIDENCE': {
      await assertOpp(action.oppId);
      const x = action.evidence;
      await prisma.evidenceEvent.create({ data: {
        id: x.id, tenantId, accountId: action.accId, opportunityId: action.oppId, personId: x.personId,
        signalKey: x.signalKey, direction: x.direction ?? 0, tier: x.tier ?? 'mid',
        rawContent: x.rawContent ?? '', occurredAt: x.occurredAt ?? '',
      } });
      return;
    }
    case 'DELETE_EVIDENCE':
      await prisma.evidenceEvent.deleteMany({ where: { id: action.evidenceId, tenantId } });
      return;

    default:
      throw new Error(`unknown action: ${t}`);
  }
}
