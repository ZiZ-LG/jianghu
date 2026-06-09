// 录入情报「回执」（共享）：录入情报口述 与 拜访纪要一键抽取（M1）共用同一张回执，
// 避免两份渲染逻辑漂移。纯展示——传入后端 /api/voice/extract 的回执对象即可。
export function IntelReceipt({ receipt, emptyHint }: { receipt: any; emptyHint?: string }) {
  const c = receipt;
  const cands = [
    ...(c.candidates?.persons ?? []).map((p: any) => `${p.name}?`),
    ...(c.candidates?.relationships ?? []).map((r: any) => `${r.source}↔${r.target}?`),
  ];
  const builtNothing = !c.account && !c.opportunity && !(c.personsCreated?.length) && !(c.edgesCreated?.length) && !cands.length;
  return (
    <>
      {(c.needConfig || c.demo) && (
        <div className="intel-demo-hint">{c.note || '未配 AI 模型。配置「🧠 AI 模型」后即可自动抽取客户/商机/干系人/关系。'}</div>
      )}
      <div className="intel-receipt">
        {c.account && <div className="ir-row">🏢 客户：<b>{c.account.name}</b>（{c.account.status === 'created' ? '新建' : '已关联'}）</div>}
        {c.opportunity && <div className="ir-row">🎯 商机：<b>{c.opportunity.name}</b>（{c.opportunity.status === 'created' ? '新建' : '已关联'}）</div>}
        {c.personsCreated?.length > 0 && <div className="ir-row">👤 新建干系人：<b>{c.personsCreated.map((p: any) => p.name).join('、')}</b> — 已上图</div>}
        {c.personsReused?.length > 0 && <div className="ir-row">♻️ 已有干系人：{c.personsReused.map((p: any) => p.name).join('、')}</div>}
        {c.rolesSet?.length > 0 && <div className="ir-row">🎭 角色：{c.rolesSet.map((r: any) => `${r.name}(${r.role})`).join('、')}</div>}
        {c.edgesCreated?.length > 0 && <div className="ir-row">🔗 关系：{c.edgesCreated.map((e: any) => `${e.source}→${e.target}`).join('、')} — 已上图</div>}
        {c.burningIssues?.length > 0 && <div className="ir-row">🔥 燃眉之急：{c.burningIssues.map((b: any) => b.person).join('、')}</div>}
        {c.ucvs?.length > 0 && <div className="ir-row">💎 独特价值：{c.ucvs.map((u: any) => `${u.person}(${u.status})`).join('、')}</div>}
        {c.visitNote && <div className="ir-row">📝 拜访纪要已存档</div>}
        {c.notes?.length > 0 && <div className="ir-row">📌 {c.notes.length} 条线索已记入干系人备注（待核实）：{c.notes.map((n: any) => `${n.person}「${n.content}」`).join('；')}</div>}
        {builtNothing && !c.needConfig && <div className="ir-row" style={{ color: 'var(--muted)' }}>{c.note || emptyHint || '这段话里没识别到可建的客户/干系人。'}</div>}
        {cands.length > 0 && (
          <div className="ir-candidates">
            ⚠️ {cands.length} 条我拿不准的，已放进「🔮 荐关系」等你定夺：
            {cands.map((s: string, i: number) => <span key={i} className="cand-chip">{s}</span>)}
          </div>
        )}
        {c.dupWarnings?.length > 0 && (
          <div className="ir-candidates">
            ⚠️ 疑似重复（已按新建上图；如与现有是同一个，请到画布 / 客户档案合并）：
            {c.dupWarnings.map((w: any, i: number) => <span key={i} className="cand-chip">{w.name} ≈ {w.similarTo}</span>)}
          </div>
        )}
      </div>
    </>
  );
}
