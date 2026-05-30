import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';

/** 为某租户创建一份演示数据（西部电力建设集团风光储项目）。每次调用用独立 id 前缀，避免冲突。 */
export async function createDemoForTenant(tenantId: string): Promise<void> {
  const rid = randomUUID().slice(0, 8);
  const id = (k: string) => `${rid}_${k}`;
  const accId = id('acc');
  const oppId = id('opp');
  const S = (v: unknown) => JSON.stringify(v);

  await prisma.account.create({ data: { id: accId, tenantId, name: '西部电力建设集团（示例）', customerType: 2, unifiedCreditCode: '91510000XXXXXXXXXX' } });

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
    id: oppId, tenantId, accountId: accId, name: '西部风光储基地数字化管控平台', customerType: 2,
    pipelineStage: '客户立项', engageStage: '方案可研', changeMode: 'T',
    singleSalesGoal: '中标西部基地一体化管控平台并建成局级样板', customerBusinessGoal: '多个新能源EPC项目降本增效 + 投标数字化加分',
    buyingMotivation: '集团数字化转型考核 + 多项目亏损预警倒逼',
    c3Items: S({ 立项原因: true, 项目名称: true, 项目预算: true, 实施计划: true, 资金来源: true, 项目排序: false, 采购方式: true }),
    c5Items: S({ 竞标方家数: true, 招标参数: true, 评标规则: false, 甲方代表: true, 招标代理: false }),
  } });

  await prisma.edge.createMany({ data: edgeRows });

  const roles: any[] = [
    ['zhao', 'A', 'plus', 2, '明确', false, null, null], ['qian', 'D', 'plus', 3, '明确', false, null, null],
    ['sun', 'R', 'star', 5, '共识', true, null, null], ['li', 'U', 'plus', 3, '明确', false, 'ownerRep', 'collude'],
    ['zhou', 'TB', 'neutral', null, '明确', false, null, null], ['zheng', 'U', 'plus', 2, '明确', false, null, null],
    ['wang', 'R', 'neutral', null, '推理', false, null, null], ['wu', 'TB', 'x', -5, '明确', false, 'purchasing', 'none'],
    ['agent', 'TB', 'neutral', null, '推理', false, 'agency', 'verbal'],
  ];
  await prisma.oppRole.createMany({ data: roles.map((r) => ({ tenantId, opportunityId: oppId, personId: id(r[0]), role: r[1], sentiment: r[2], sentimentValue: r[3], confidence: r[4], isKeyInfluencer: r[5], procurementType: r[6], procurementStatus: r[7] })) });

  const biId = id('bi_qian');
  await prisma.burningIssue.create({ data: { id: biId, tenantId, opportunityId: oppId, personId: id('qian'), description: '集团数字化考核排名靠后 + 个人晋升关口(处长→部门总)', category: '个人晋升', isPrivate: true, confidence: '明确' } });
  await prisma.uCV.create({ data: { id: id('ucv1'), tenantId, opportunityId: oppId, targetBiId: biId, description: '把投资—造价—成本一体化包装成“可向集团对标上报的降本标杆成果”，助其考核进位', competitorCannot: '对手只卖软件，给不了可交账的标杆政绩', status: '获认可' } });
}
