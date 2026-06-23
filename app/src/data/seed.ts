// 演示种子数据：某电力建设集团「西部风光储基地数字化管控平台」项目
// 场景设计为「相对优势·可争取」(~67%)，把任一拍板人D的态度改成 x 即可见趋赢力大幅下滑。
import type { Account } from '../types';

export const seedAccount: Account = {
  id: 'acc_powerbuild',
  name: '西部电力建设集团',
  customerType: 4, // EPC总承包商（v1.1，原"央国企电力建设集团"）
  unifiedCreditCode: '91510000XXXXXXXXXX',
  persons: [
    {
      id: 'zhao', name: '赵建国', title: '集团分管副总', orgLevel: 1, x: 430, y: 90,
      form: {
        family: '独子在国外读研', occupation: '工程口出身，技术转管理', recreation: '书法、太极',
        moneyMotivation: '任内做出数字化标杆，安全着陆',
        family7: { 籍贯: '陕西', 年纪: '57', 毕业院校: '河海大学', 配偶: '同系统退休', 子女: '独子·留学', 父母: '老家高龄' },
      },
      logs: [{ date: '2026-03', content: '行业峰会上做过简短交流，对数字化转型有判断', sensitive: false }],
    },
    {
      id: 'wang', name: '王教授', title: '外部专家顾问', orgLevel: 2, x: 650, y: 110,
      form: { family: '', occupation: '行业大拿、评标专家库', recreation: '茶道', moneyMotivation: '学术尊重与咨询回报', family7: {} },
      coachLevel: 2,
      logs: [],
    },
    {
      id: 'qian', name: '钱大钧', title: '信息化部部长', orgLevel: 2, x: 250, y: 250,
      form: {
        family: '爱人在总部机关，老大今年高考', occupation: '信息化深耕，处级多年', recreation: '红酒、高尔夫',
        moneyMotivation: '数字化考核进位 + 个人晋升(处长→部门总)',
        family7: { 籍贯: '四川', 年纪: '48', 毕业院校: '电子科大', 配偶: '总部机关', 子女: '高三', 父母: '同城' },
      },
      logs: [
        { date: '2026-04', content: '餐叙引出家庭与考核压力，关系升至明确支持', sensitive: false },
        { date: '2026-05', content: '招采方案预对齐：就评分权重达成共识', sensitive: true, visibility: 'team' },
      ],
    },
    {
      id: 'sun', name: '孙学文', title: '集团总工 / 专家组长', orgLevel: 2, x: 560, y: 250,
      form: {
        family: '书香门第', occupation: '国务院津贴专家', recreation: '摄影',
        moneyMotivation: '行业学术地位与传承',
        family7: { 籍贯: '江苏', 年纪: '55', 毕业院校: '清华', 配偶: '高校教师', 子女: '已工作', 父母: '已故' },
      },
      coachLevel: 4,
      logs: [{ date: '2026-05', content: '愿在评审中以"一体化可对标"角度排他性力挺我方', sensitive: false }],
    },
    {
      id: 'wu', name: '吴强', title: '采购管理部经理', orgLevel: 3, x: 150, y: 420,
      form: { family: '单身', occupation: '钱大钧老乡心腹', recreation: 'KTV', moneyMotivation: '搞钱', family7: { 籍贯: '四川' } },
      logs: [{ date: '2026-05', content: '疑似被友商A接触，态度倒向对手', sensitive: false }],
    },
    {
      id: 'zhou', name: '周小波', title: '财务 / 审核', orgLevel: 3, x: 320, y: 420,
      form: { family: '二胎', occupation: '审计出身', recreation: '钓鱼', moneyMotivation: '稳定、不出错', family7: { 籍贯: '湖南', 年纪: '40' } },
      logs: [],
    },
    {
      id: 'li', name: '李进', title: '项目经理(甲方代表)', orgLevel: 3, x: 470, y: 420,
      form: { family: '凤凰男、孩子小', occupation: '执行力强', recreation: '王者荣耀', moneyMotivation: '升职加薪', family7: { 籍贯: '河南', 年纪: '35' } },
      logs: [{ date: '2026-05', content: '作为甲方项目代表，已就技术门槛与我方密谋(招采方案预对齐)', sensitive: true, visibility: 'team' }],
    },
    {
      id: 'zheng', name: '郑工', title: '信息化骨干', orgLevel: 3, x: 620, y: 420,
      form: { family: '刚结婚', occupation: '技术宅', recreation: '动漫', moneyMotivation: '技术成长', family7: { 籍贯: '山东', 年纪: '30' } },
      logs: [],
    },
    {
      id: 'agent', name: '某招标代理', title: '招标代理机构', orgLevel: 3, x: 80, y: 250,
      form: { family: '', occupation: '招标代理', recreation: '', moneyMotivation: '代理费', family7: {} },
      logs: [],
    },
    {
      id: 'competitor', name: '友商A', title: '竞争对手', orgLevel: 2, x: 60, y: 420, isCompetitor: true,
      form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} },
      logs: [],
    },
  ],

  baseEdges: [
    // L1 组织汇报（正交线）
    { id: 'b1', source: 'zhao', target: 'qian', layer: 'L1', label: '直属', directed: true },
    { id: 'b2', source: 'zhao', target: 'sun', layer: 'L1', label: '分管', directed: true },
    { id: 'b3', source: 'qian', target: 'wu', layer: 'L1', label: '直属', directed: true },
    { id: 'b4', source: 'sun', target: 'zheng', layer: 'L1', label: '师徒', directed: true },
    { id: 'b5', source: 'qian', target: 'zhou', layer: 'L1', label: '行政', directed: true },
    { id: 'b6', source: 'li', target: 'qian', layer: 'L1', label: '业务', style: 'dashed', directed: true },
    { id: 'b7', source: 'li', target: 'sun', layer: 'L1', label: '技术', style: 'dashed', directed: true },
    // L3 存量私交（跨项目持久）
    { id: 'b8', source: 'sun', target: 'li', layer: 'L3', label: '校友', color: '#16a34a' },
    { id: 'b9', source: 'qian', target: 'wu', layer: 'L3', label: '亲戚', color: '#16a34a' },
    { id: 'b10', source: 'qian', target: 'sun', layer: 'L3', label: '宿怨', color: '#ef4444', style: 'dashed' },
    { id: 'b11', source: 'wang', target: 'sun', layer: 'L3', label: '同门', color: '#16a34a' },
  ],

  opportunities: [
    {
      id: 'opp_west',
      accountId: 'acc_powerbuild',
      name: '西部风光储基地数字化管控平台',
      customerType: 4,
      pipelineStage: '客户立项',
      engageStage: '方案可研', // C4 → 4
      changeMode: 'T',
      singleSalesGoal: '中标西部基地一体化管控平台（投资+造价+EPC）并建成局级样板',
      customerBusinessGoal: '多个新能源EPC项目降本增效 + 投标数字化加分',
      buyingMotivation: '集团数字化转型考核 + 多项目亏损预警倒逼',
      c3Items: { 立项原因: true, 项目名称: true, 项目预算: true, 实施计划: true, 资金来源: true, 项目排序: false, 采购方式: true },
      c5Items: { 竞标方家数: true, 招标参数: true, 评标规则: false, 甲方代表: true, 招标代理: false },
      roles: [
        { personId: 'zhao', role: 'A', sentiment: 'plus', sentimentValue: 2, confidence: '明确' },
        { personId: 'qian', role: 'D', sentiment: 'plus', sentimentValue: 3, confidence: '明确' },
        { personId: 'sun', role: 'C', sentiment: 'star', sentimentValue: 5, confidence: '共识', isKeyInfluencer: true },
        { personId: 'li', role: 'U', sentiment: 'plus', sentimentValue: 3, confidence: '明确', procurementType: 'ownerRep', procurementStatus: 'collude' },
        { personId: 'zhou', role: 'R', sentiment: 'neutral', confidence: '明确' },
        { personId: 'zheng', role: 'U', sentiment: 'plus', sentimentValue: 2, confidence: '明确' },
        { personId: 'wang', role: 'C', sentiment: 'neutral', confidence: '推理' },
        { personId: 'wu', role: 'R', sentiment: 'x', sentimentValue: -5, confidence: '明确', procurementType: 'purchasing', procurementStatus: 'none' },
        { personId: 'agent', role: 'R', sentiment: 'neutral', confidence: '推理', procurementType: 'agency', procurementStatus: 'verbal' },
      ],
      bis: [
        {
          id: 'bi_qian', personId: 'qian',
          description: '集团数字化考核排名靠后 + 个人晋升关口(处长→部门总)',
          category: '个人晋升', isPrivate: true, confidence: '明确',
        },
      ],
      ucvs: [
        {
          id: 'ucv1', targetBiId: 'bi_qian',
          description: '把投资—造价—成本一体化包装成"可向集团对标上报的降本标杆成果"，助其考核进位',
          competitorCannot: '对手只卖软件，给不了可交账的标杆政绩',
          status: '获认可',
        },
      ],
      edges: [
        // L2 决策权力
        { id: 'p1', source: 'sun', target: 'qian', layer: 'L2', label: '技术否决', color: '#b91c1c', width: 3, directed: true },
        { id: 'p2', source: 'wang', target: 'zhao', layer: 'L2', label: '顾问影响', color: '#9333ea', style: 'dashed', width: 2, directed: true },
        { id: 'p3', source: 'wu', target: 'li', layer: 'L2', label: '卡流程', color: '#f97316', width: 2, directed: true },
        { id: 'p4', source: 'zheng', target: 'sun', layer: 'L2', label: '数据支撑', color: '#16a34a', directed: true },
        { id: 'p5', source: 'qian', target: 'zhou', layer: 'L2', label: '授意严查', color: '#1f2937', width: 2, directed: true },
        // L3 项目情感
        { id: 'p6', source: 'wu', target: 'li', layer: 'L3', label: '刁难', color: '#ef4444', directed: true },
        { id: 'p7', source: 'zheng', target: 'li', layer: 'L3', label: '共鸣', color: '#16a34a', style: 'dashed' },
        { id: 'p8', source: 'wang', target: 'qian', layer: 'L3', label: '被拉拢', color: '#f97316', style: 'dashed', directed: true },
        // L4 战略本质
        { id: 'p9', source: 'competitor', target: 'wu', layer: 'L4', label: '利益输送', color: '#ef4444', width: 2, directed: true },
        { id: 'p10', source: 'competitor', target: 'wang', layer: 'L4', label: '学术公关', color: '#f97316', style: 'dashed', directed: true },
        { id: 'p11', source: 'sun', target: 'zhao', layer: 'L4', label: '信任背书', color: '#16a34a', width: 3, directed: true },
      ],
    },
  ],
};
