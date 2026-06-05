import { useState } from 'react';
import type { Account, AccountProfile } from '../types';
import { CUSTOMER_TYPE_LABEL } from '../types';
import { Modal } from './Modal';
import { VisitTimeline } from './VisitTimeline';

/** 客户档案七维度（对应 AccountProfile，WorkBuddy 推送/销售手填） */
const PROFILE_FIELDS: { key: keyof AccountProfile; label: string; ph: string }[] = [
  { key: 'business', label: '工商基础', ph: '注册资本 / 成立日期 / 法定代表人 / 经营范围' },
  { key: 'group', label: '集团关系', ph: '母子公司 / 控股结构' },
  { key: 'bidding', label: '招投标', ph: '历史 / 在招项目摘要' },
  { key: 'risk', label: '风险信号', ph: '诉讼 / 失信 / 经营异常' },
  { key: 'ourCooperation', label: '我方现有合作', ph: '已签 / 在执行 / 历史交付' },
  { key: 'salesNote', label: '销售背景', ph: '销售手工补充的背景信息' },
  { key: 'aiSuggestion', label: 'AI 建议', ph: '销售包 AI 生成的攻坚建议（参考，不计分）' },
];

/** 客户档案视图：展示/编辑 region/group/primaryOwner + 企业背景档案(profile)，并内嵌拜访记录时间线。 */
export function CustomerProfile({ account, onSave, onClose }: {
  account: Account;
  onSave: (patch: Partial<Account>) => void;
  onClose: () => void;
}) {
  const [region, setRegion] = useState(account.region ?? '');
  const [group, setGroup] = useState(account.group ?? '');
  const [primaryOwner, setPrimaryOwner] = useState(account.primaryOwner ?? '');
  const [profile, setProfile] = useState<AccountProfile>(account.profile ?? {});
  const setP = (k: keyof AccountProfile, v: string) => setProfile((p) => ({ ...p, [k]: v }));

  const oppNameById = new Map(account.opportunities.map((o) => [o.id, o.name]));
  const visits = account.visitNotes ?? [];

  const save = () => {
    onSave({ region, group, primaryOwner, profile });
    onClose();
  };

  return (
    <Modal title={`${account.name} · 客户档案`} width={600} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save}>保存</button>
      </>}>
      <div className="profile-tags">
        <span className="acc-type">{CUSTOMER_TYPE_LABEL[account.customerType]}</span>
        {account.externalRef && <span className="src-tag">销售包 {account.externalRef}</span>}
        {account.unifiedCreditCode && <span className="src-tag">USCC {account.unifiedCreditCode}</span>}
      </div>

      <div className="fld-row">
        <label className="fld"><span>大区</span><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="如：华北" /></label>
        <label className="fld"><span>集团/母公司</span><input value={group} onChange={(e) => setGroup(e.target.value)} /></label>
        <label className="fld"><span>主负责人</span><input value={primaryOwner} onChange={(e) => setPrimaryOwner(e.target.value)} /></label>
      </div>

      <div className="section-t">企业背景档案</div>
      {PROFILE_FIELDS.map((f) => (
        <label className="fld sm" key={f.key}>
          <span>{f.label}</span>
          <textarea rows={2} value={profile[f.key] ?? ''} onChange={(e) => setP(f.key, e.target.value)} placeholder={f.ph} />
        </label>
      ))}

      <div className="section-t">拜访记录 <span className="vn-count">{visits.length}</span></div>
      <VisitTimeline visits={visits} oppNameById={oppNameById} />
    </Modal>
  );
}
