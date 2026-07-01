// 「＋ 添加情报」单入口（P3，落地 docs/添加情报-单入口原型.html）：
// 纯人工喂料三合一——✍️口述录入 / 🎧录音转写 / 💬和地图对话，收编原先分散的入口（顶栏录入情报 + 工具条录音接入 + 左栏对话）。
// 「🔍 自算补全」是 AI 后台主动挖、非「添加」动作 → 留在工具条收件箱旁（产物进收件箱人审），不并入此处。
// 三个输入体各自已守铁律②（明说直落、推断进收件箱），此处只做单入口容器，不碰落库逻辑。
import { useState } from 'react';
import type { Account, Opportunity } from '../types';
import { Modal } from './Modal';
import { IntelCapture } from './IntelCapture';
import { RecordingPanel } from './RecordingPanel';
import { ChatPanel } from './ChatPanel';

type Way = 'dictate' | 'record' | 'chat';
const WAYS: { key: Way; icon: string; title: string; desc: string; hot?: boolean }[] = [
  { key: 'dictate', icon: '✍️', title: '口述录入', desc: '粘贴拜访口述 / 打字，AI 整理成图', hot: true },
  { key: 'record', icon: '🎧', title: '录音转写', desc: '飞书妙记 · 上传文件 · 得到大脑' },
  { key: 'chat', icon: '💬', title: '和地图对话', desc: '问一句、补一条，边聊边建' },
];

export function AddIntel({ account, opp, role, onClose, onDone }: {
  account: Account; opp: Opportunity | null; role: string;
  onClose: () => void; onDone: () => void; // 落库后刷新整树 + 收件箱
}) {
  const [way, setWay] = useState<Way>('dictate');
  return (
    <Modal title="＋ 添加情报" onClose={onClose} width={860}
      footer={<span style={{ fontSize: 11.5, color: 'var(--muted)' }}>🟢 你明说的 → 直落正式库　🔴 AI 补充 / 脑补 → 进 📥 收件箱待采纳（铁律②）</span>}>
      <div className="addintel">
        <div className="addintel-nav">
          {WAYS.map((w) => (
            <button key={w.key} className={`addintel-way${way === w.key ? ' active' : ''}`} onClick={() => setWay(w.key)}>
              <span className="aw-ico">{w.icon}</span>
              <span className="aw-tx">
                <span className="aw-t">{w.title}{w.hot && <span className="aw-hot">最常用</span>}</span>
                <span className="aw-d">{w.desc}</span>
              </span>
            </button>
          ))}
          <div className="addintel-hint">想让 AI <b>主动发现</b>干系人？用工具条「🔍 自算补全」——那是后台活，产物进 📥 收件箱人审。</div>
        </div>
        <div className="addintel-body">
          {way === 'dictate' && (
            <IntelCapture embedded account={account} opportunity={opp} onClose={onClose} onDone={onDone} />
          )}
          {way === 'record' && (
            <RecordingPanel embedded accountId={account.id} role={role} onClose={onClose} onExtracted={onDone} />
          )}
          {way === 'chat' && (
            opp
              ? <div className="addintel-chat"><ChatPanel account={account} opp={opp} onDone={onDone} height={340} /></div>
              : <div className="addintel-empty">先选一个商机，才能和这张地图对话补情报。</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
