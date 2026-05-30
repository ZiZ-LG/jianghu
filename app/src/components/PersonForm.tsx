import { useState } from 'react';
import { Modal } from './Modal';

export function PersonForm({
  onCreate, onClose,
}: {
  onCreate: (name: string, title: string, isCompetitor: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [isComp, setIsComp] = useState(false);

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), title.trim() || '待补职务', isComp);
    onClose();
  };

  return (
    <Modal title="新建干系人" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit} disabled={!name.trim()}>添加到作战地图</button>
      </>}>
      <label className="fld"><span>姓名</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="如：钱大钧" /></label>
      <label className="fld"><span>职务</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：信息化部部长" /></label>
      <label className="chk-line">
        <input type="checkbox" checked={isComp} onChange={(e) => setIsComp(e.target.checked)} />
        这是竞争对手（友商，不分配角色）
      </label>
      <div className="hint-text">添加后点击节点可在右侧档案里填 FORM、分配角色、记录 BI/UCV。</div>
    </Modal>
  );
}
