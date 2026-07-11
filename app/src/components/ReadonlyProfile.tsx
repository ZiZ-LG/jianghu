// viewer（只读投影）档案视图：与 DetailDrawer 同数据、纯呈现——编辑控件一律不渲染（契约 v1.0 §二-1：
// 不是禁用置灰，是不出现）。晚间收口拷问的第二屏：让销售「看图说话」，信息密度对齐编辑版。
import type { Person, OppRole, BurningIssue, UCV } from '../types';
import {
  ROLE_LABEL, SENTIMENT_CHAR, SENTIMENT_LABEL, FAMILY_7Q,
  PROCUREMENT_TYPE_LABEL, PROCUREMENT_STATUS_LABEL,
} from '../types';

const Line = ({ k, v }: { k: string; v?: string }) => (
  <div className="ro-line"><span className="ro-k">{k}</span><span className="ro-v">{v?.trim() ? v : '—'}</span></div>
);

export function ReadonlyProfile({ person, oppRole, bis, ucvs }: {
  person: Person;
  oppRole?: OppRole;
  bis: BurningIssue[];
  ucvs: UCV[];
}) {
  const f = person.form;
  const fam7 = FAMILY_7Q.filter((q) => (f.family7[q] ?? '').trim());
  return (
    <div className="drawer-body ro-profile">
      {person.isCompetitor ? (
        <div className="empty-hint">竞争对手不分配角色；其影响体现在客户方人员的「✕ 倒向对手」标记上。</div>
      ) : (
        <>
          <div className="section-t">本项目角色与态度</div>
          <Line k="角色" v={oppRole ? `${oppRole.role} · ${ROLE_LABEL[oppRole.role]}` : '未分配'} />
          <Line k="支持度" v={oppRole ? `${SENTIMENT_CHAR[oppRole.sentiment]} ${SENTIMENT_LABEL[oppRole.sentiment]}` : undefined} />
          {oppRole && (
            <>
              <Line k="信息可信度" v={oppRole.confidence} />
              {oppRole.isKeyInfluencer && <Line k="关键影响人(P4)" v="已锁定 ★" />}
              {oppRole.procurementType && (
                <Line k="招采关键人" v={`${PROCUREMENT_TYPE_LABEL[oppRole.procurementType]} · ${PROCUREMENT_STATUS_LABEL[oppRole.procurementStatus ?? 'none']}`} />
              )}
            </>
          )}

          <div className="section-t">FORM 情报</div>
          <Line k="F 家庭" v={f.family} />
          <Line k="O 事业" v={f.occupation} />
          <Line k="R 休闲" v={f.recreation} />
          <Line k="M 金钱与梦想" v={f.moneyMotivation} />

          <div className="section-t">家庭 7 问（C1 计分项）</div>
          {fam7.length === 0 ? (
            <div className="empty-hint">暂未采集</div>
          ) : (
            fam7.map((q) => <Line key={q} k={q} v={f.family7[q]} />)
          )}

          <div className="section-t">燃眉之急 BI</div>
          {bis.length === 0 && <div className="empty-hint">暂无 BI</div>}
          {bis.map((bi) => (
            <div className="bi-card" key={bi.id}>
              <div className="ro-tagline"><b>{bi.category}</b><span className="ro-conf">{bi.confidence}</span></div>
              <div className="ro-body">{bi.description || '—'}</div>
            </div>
          ))}

          <div className="section-t">独特价值 UCV → C6</div>
          {ucvs.length === 0 && <div className="empty-hint">暂无 UCV</div>}
          {ucvs.map((u) => (
            <div className="ucv-card" key={u.id}>
              <div className="ro-tagline"><b>{u.status}</b></div>
              <div className="ro-body">{u.description || '—'}</div>
              {u.competitorCannot && <div className="ro-sub">对手给不了：{u.competitorCannot}</div>}
            </div>
          ))}

          <div className="section-t">交往日志</div>
          {person.logs.length > 0 ? (
            <div className="timeline">
              {person.logs.map((log, i) => (
                <div className="tl-item" key={i}>
                  <div className="dt">{log.date}{log.sensitive && <span className="sensitive-tag">敏感·仅团队</span>}</div>
                  <div className="ct">{log.content}</div>
                </div>
              ))}
            </div>
          ) : <div className="empty-hint">暂无记录</div>}
        </>
      )}
    </div>
  );
}
