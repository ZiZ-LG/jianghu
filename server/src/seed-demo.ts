import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { shiftBusinessYmd } from './businessDate.js';

/** 为某租户创建一份演示数据（西部电力建设集团风光储项目）。每次调用用独立 id 前缀，避免冲突。 */
export async function createDemoForTenant(tenantId: string): Promise<void> {
  const rid = randomUUID().replaceAll('-', '');
  const id = (k: string) => `${rid}_${k}`;
  const accId = id('acc');
  const oppId = id('opp');
  const S = (v: unknown) => JSON.stringify(v);
  const today = new Date();
  const ymd = (off: number) => shiftBusinessYmd(today, off);

  await prisma.account.create({ data: { id: accId, tenantId, name: '西部电力建设集团（示例）', customerType: 4, unifiedCreditCode: '91510000XXXXXXXXXX' } });

  const persons = [
    { k: 'zhao', name: '赵建国', title: '集团分管副总', orgLevel: 1, x: 430, y: 90, form: { family: '独子在国外读研', occupation: '工程口出身，技术转管理', recreation: '书法、太极', moneyMotivation: '任内做出数字化标杆，安全着陆', family7: { 籍贯: '陕西', 年纪: '57', 毕业院校: '河海大学', 配偶: '同系统退休', 子女: '独子·留学', 父母: '老家高龄' } } },
    { k: 'wang', name: '王教授', title: '外部专家顾问', orgLevel: 2, x: 650, y: 110, coachLevel: 2, form: { family: '', occupation: '行业大拿、评标专家库', recreation: '茶道', moneyMotivation: '学术尊重与咨询回报', family7: {} } },
    { k: 'qian', name: '钱大钧', title: '信息化部部长', orgLevel: 2, x: 250, y: 250, form: { family: '爱人在总部机关，老大今年高考', occupation: '信息化深耕，处级多年', recreation: '红酒、高尔夫', moneyMotivation: '数字化考核进位 + 个人晋升', family7: { 籍贯: '四川', 年纪: '48', 毕业院校: '电子科大', 配偶: '总部机关', 子女: '高三', 父母: '同城' } } },
    { k: 'sun', name: '孙学文', title: '集团总工 / 专家组长', orgLevel: 2, x: 560, y: 250, coachLevel: 4, form: { family: '书香门第', occupation: '国务院津贴专家', recreation: '摄影', moneyMotivation: '行业学术地位与传承', family7: { 籍贯: '江苏', 年纪: '55', 毕业院校: '清华', 配偶: '高校教师', 子女: '已工作', 父母: '已故' } } },
    { k: 'wu', name: '吴强', title: '采购管理部经理', orgLevel: 3, x: 150, y: 420, form: { family: '单身', occupation: '钱大钧老乡心腹', recreation: 'KTV', moneyMotivation: '搞钱', family7: { 籍贯: '四川' } } },
    { k: 'zhou', name: '周小波', title: '财务 / 审核', orgLevel: 3, x: 320, y: 420, form: { family: '二胎', occupation: '审计出身', recreation: '钓鱼', moneyMotivation: '稳定、不出错', family7: { 籍贯: '湖南', 年纪: '40' } } },
    { k: 'li', name: '李进', title: '项目经理(甲方代表)', orgLevel: 3, x: 470, y: 420, form: { family: '凤凰男、孩子小', occupation: '执行力强', recreation: '王者荣耀', moneyMotivation: '升职加薪', family7: { 籍贯: '河南', 年纪: '35' } } },
    { k: 'zheng', name: '郑工', title: '信息化骨干', orgLevel: 3, x: 620, y: 420, form: { family: '刚结婚', occupation: '技术宅', recreation: '动漫', moneyMotivation: '技术成长', family7: { 籍贯: '山东', 年纪: '30' } } },
    { k: 'agent', name: '某招标代理', title: '招标代理机构', orgLevel: 3, x: 80, y: 250, form: { family: '', occupation: '招标代理', recreation: '', moneyMotivation: '代理费', family7: {} } },
    { k: 'competitor', name: '友商A', title: '竞争对手', orgLevel: 2, x: 60, y: 420, isCompetitor: true, form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} } },
  ];
  await prisma.person.createMany({ data: persons.map((p) => ({ id: id(p.k), tenantId, accountId: accId, name: p.name, title: p.title, orgLevel: p.orgLevel, isCompetitor: !!(p as any).isCompetitor, coachLevel: (p as any).coachLevel ?? null, x: p.x, y: p.y, form: S(p.form), logs: '[]' })) });

  const baseEdges = [
    ['zhao', 'qian', 'L1', '直属', null, null, true], ['zhao', 'sun', 'L1', '分管', null, null, true],
    ['qian', 'wu', 'L1', '直属', null, null, true], ['sun', 'zheng', 'L1', '师徒', null, null, true],
    ['qian', 'zhou', 'L1', '行政', null, null, true], ['li', 'qian', 'L1', '业务', null, 'dashed', true], ['li', 'sun', 'L1', '技术', null, 'dashed', true],
    ['sun', 'li', 'L3', '校友', '#16a34a', null, false], ['qian', 'wu', 'L3', '亲戚', '#16a34a', null, false],
    ['qian', 'sun', 'L3', '宿怨', '#ef4444', 'dashed', false], ['wang', 'sun', 'L3', '同门', '#16a34a', null, false],
  ];
  const projEdges = [
    ['sun', 'qian', 'L2', '技术否决', '#b91c1c', null, true, 3], ['wang', 'zhao', 'L2', '顾问影响', '#9333ea', 'dashed', true, 2],
    ['wu', 'li', 'L2', '卡流程', '#f97316', null, true, 2], ['zheng', 'sun', 'L2', '数据支撑', '#16a34a', null, true, null],
    ['qian', 'zhou', 'L2', '授意严查', '#1f2937', null, true, 2],
    ['wu', 'li', 'L3', '刁难', '#ef4444', null, true, null], ['zheng', 'li', 'L3', '共鸣', '#16a34a', 'dashed', false, null], ['wang', 'qian', 'L3', '被拉拢', '#f97316', 'dashed', true, null],
    ['competitor', 'wu', 'L4', '利益输送', '#ef4444', null, true, 2], ['competitor', 'wang', 'L4', '学术公关', '#f97316', 'dashed', true, null], ['sun', 'zhao', 'L4', '信任背书', '#16a34a', null, true, 3],
  ];
  const edgeRows = [
    ...baseEdges.map((e, i) => ({ id: id(`be${i}`), tenantId, accountId: accId, opportunityId: null, source: id(e[0] as string), target: id(e[1] as string), layer: e[2] as string, label: e[3] as string, color: (e[4] as string) ?? null, style: (e[5] as string) ?? null, width: null as number | null, directed: !!e[6], origin: 'manual' })),
    ...projEdges.map((e, i) => ({ id: id(`pe${i}`), tenantId, accountId: accId, opportunityId: oppId, source: id(e[0] as string), target: id(e[1] as string), layer: e[2] as string, label: e[3] as string, color: (e[4] as string) ?? null, style: (e[5] as string) ?? null, width: (e[7] as number) ?? null, directed: !!e[6], origin: 'manual' })),
  ];
  // 先建商机（连线/角色等引用它，须先存在）
  await prisma.opportunity.create({ data: {
    id: oppId, tenantId, accountId: accId, name: '西部风光储基地数字化管控平台', customerType: 4,
    pipelineStage: '客户立项', engageStage: '方案可研', changeMode: 'T',
    singleSalesGoal: '中标西部基地一体化管控平台并建成局级样板', customerBusinessGoal: '多个新能源EPC项目降本增效 + 投标数字化加分',
    buyingMotivation: '集团数字化转型考核 + 多项目亏损预警倒逼',
    c3Items: S({ 立项原因: true, 项目名称: true, 项目预算: true, 实施计划: true, 资金来源: true, 项目排序: false, 采购方式: true }),
    c5Items: S({ '竞标方名单/家数': true, 招标参数: true, 评标规则: false, 甲方项目代表: true, 招标代理机构: false }),
    expectedSignDate: ymd(120), expectedAmountW: 2000,
  } });

  await prisma.edge.createMany({ data: edgeRows });

  const roles: any[] = [
    ['zhao', 'A', 'plus', 2, '明确', false, null, null], ['qian', 'D', 'plus', 3, '明确', false, null, null],
    ['sun', 'C', 'star', 5, '共识', true, null, null], ['li', 'U', 'plus', 3, '明确', false, 'ownerRep', 'collude'],
    ['zhou', 'R', 'neutral', null, '明确', false, null, null], ['zheng', 'U', 'plus', 2, '明确', false, null, null],
    ['wang', 'C', 'neutral', null, '推理', false, null, null], ['wu', 'R', 'x', -5, '明确', false, 'purchasing', 'none'],
    ['agent', 'R', 'neutral', null, '推理', false, 'agency', 'verbal'],
  ];
  await prisma.oppRole.createMany({ data: roles.map((r) => ({ tenantId, opportunityId: oppId, personId: id(r[0]), role: r[1], sentiment: r[2], sentimentValue: r[3], confidence: r[4], isKeyInfluencer: r[5], procurementType: r[6], procurementStatus: r[7] })) });

  const biId = id('bi_qian');
  await prisma.burningIssue.create({ data: { id: biId, tenantId, opportunityId: oppId, personId: id('qian'), description: '集团数字化考核排名靠后 + 个人晋升关口(处长→部门总)', category: '个人晋升', isPrivate: true, confidence: '明确' } });
  await prisma.uCV.create({ data: { id: id('ucv1'), tenantId, opportunityId: oppId, targetBiId: biId, description: '把投资—造价—成本一体化包装成“可向集团对标上报的降本标杆成果”，助其考核进位', competitorCannot: '对手只卖软件，给不了可交账的标杆政绩', status: '获认可' } });

  // ── 行动计划示例：阶段段（年视图）+ 里程碑（倒排）+ 行动（关联缺口/干系人，含完成态）──
  await prisma.oppStage.createMany({ data: ([
    ['需求引导', -45, -5], ['方案认可', -4, 35], ['客户立项', 20, 55], ['招投标', 60, 100], ['合同谈判', 100, 125],
  ] as [string, number, number][]).map((g, i) => ({ id: id(`st${i}`), tenantId, accountId: accId, opportunityId: oppId, stageKey: g[0], startDate: ymd(g[1]), endDate: ymd(g[2]) })) });

  await prisma.oppMilestone.createMany({ data: ([
    ['立项评审过会', 15], ['预算批复', 40], ['招标挂网', 70], ['开标评标', 95], ['合同双签', 120],
  ] as [string, number][]).map((m, i) => ({ id: id(`ms${i}`), tenantId, accountId: accId, opportunityId: oppId, title: m[0], startDate: ymd(m[1]), endDate: ymd(m[1]), half: 'am' })) });

  await prisma.planAction.createMany({ data: ([
    ['拜访孙学文(教练)，请其在评标专家层压制吴强卡点', 'P2', 'sun', -3, 'am', true, '', ''],
    ['约钱大钧打高尔夫，摸清向集团汇报的政绩诉求', 'P3', 'qian', 2, 'am', false, '非正式高尔夫局', '这套能帮您做出可向集团对标上报的成果，汇报材料我来备'],
    ['准备“局级降本标杆”汇报材料，借钱大钧引荐上赵建国', '1K', 'zhao', 5, 'pm', false, '', ''],
    ['CP3D 信创实测演示给信息化骨干郑工，建技术口碑', 'C6', 'zheng', 8, 'pm', false, '', ''],
    ['推动评标规则向“一体化降本能力”倾斜', 'C5', 'li', 12, 'am', false, '', ''],
  ] as [string, string, string, number, string, boolean, string, string][]).map((a, i) => ({ id: id(`pa${i}`), tenantId, accountId: accId, opportunityId: oppId, title: a[0], gapItem: a[1], personId: id(a[2]), scene: a[6], scripts: a[7], target: '', ownerId: '', startDate: ymd(a[3]), endDate: ymd(a[3]), half: a[4], done: a[5], doneAt: a[5] ? ymd(a[3]) : null, review: '', origin: 'manual', createdBy: '' })) });

  // ── 策略沙盘示例：策略卡（挂靠 G64111 缺口，含 AI 来源）+ 风险/假设 + 弹药 ──
  await prisma.strategyCard.createMany({ data: ([
    ['P3', '借局级样板案例约钱大钧单独深谈，摸清政绩诉求、做到“密谋级”支持', '当前 P3 仅明确支持(plus)，与拍板人深度不足；钱大钧 BI=数字化考核+个人晋升', 'qian', 'manual'],
    ['1K', '通过钱大钧引荐触达赵建国，用可上报的降本标杆数据换 A 背书', '1K 仅 plus，批准人关系浅；忌越级引发 D 反噬', 'zhao', 'ai'],
    ['P2', '争取孙学文出面，压制吴强在招采环节的卡点，至少做到口头承诺', '招采关键人吴强已倒向友商A(x)，P2 严重短板需防守', 'wu', 'manual'],
    ['C5', '推动评标规则向“一体化降本能力”倾斜、锁定中性招标代理', 'C5 招采五事项缺评标规则+招标代理两项', 'li', 'ai'],
    ['C6', '把投资-造价-成本一体化 UCV 做成可交账的降本标杆，争取客户书面认可', 'UCV 已获认可，需推到“已解决”巩固独特价值', 'qian', 'manual'],
  ] as [string, string, string, string, string][]).map((c, i) => ({ id: id(`sc${i}`), tenantId, accountId: accId, opportunityId: oppId, gapItem: c[0], title: c[1], basis: c[2], alternatives: '', personId: id(c[3]), status: 'active', origin: c[4], orderIndex: i, dispatchedActionIds: '[]' })) });

  await prisma.strategyRisk.createMany({ data: ([
    ['risk', '吴强(采购)已倒向友商A，可能在招采参数/评标环节设卡', 'high', '借孙学文+合规流程对冲，必要时拆包绕开其强项'],
    ['risk', '越级直接找赵建国会让钱大钧觉得被架空，P3 可能由正转负', 'high', '一律走“D 引荐上 A”，给钱大钧政绩、不抢功'],
    ['assumption', '假设孙学文(教练)愿在评标专家层为我方背书', 'mid', ''],
    ['assumption', '假设 12 月预算批复如期，否则签约顺延一季度', 'mid', ''],
  ] as [string, string, string, string][]).map((r, i) => ({ id: id(`sr${i}`), tenantId, accountId: accId, opportunityId: oppId, kind: r[0], text: r[1], severity: r[2], mitigation: r[3], status: 'open', origin: 'manual' })) });

  await prisma.strategyResource.createMany({ data: ([
    ['CP3D 信创实测报告', 'product', '证明信创合规+性能'],
    ['局级降本标杆案例(可对标上报)', 'case', '帮钱大钧拿政绩'],
    ['孙学文教练 + 王教授专家关系', 'relation', '评标专家层影响力'],
    ['框架协议绑定多 EPC 项目的商务让利空间', 'commercial', ''],
  ] as [string, string, string][]).map((x, i) => ({ id: id(`sx${i}`), tenantId, accountId: accId, opportunityId: oppId, label: x[0], kind: x[1], note: x[2] })) });
}
