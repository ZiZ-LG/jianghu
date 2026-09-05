import type { FormEvent, ReactNode } from 'react';

export function PersonalForm({ title, busy, error, onSubmit, onClose, children, submitLabel = '确认保存' }: {
  title: string; busy: boolean; error: string; onSubmit: (event: FormEvent) => void; onClose: () => void; children: ReactNode; submitLabel?: string;
}) {
  return <form className="personal-form" aria-label={title} onSubmit={onSubmit}>
    <header><h3>{title}</h3><button type="button" className="btn ghost sm" disabled={busy} onClick={onClose}>收起</button></header>
    <fieldset disabled={busy}>{children}</fieldset>
    {error ? <p className="personal-error" role="alert">{error}</p> : null}
    <button className="btn primary" type="submit" disabled={busy}>{busy ? '正在保存…' : submitLabel}</button>
  </form>;
}
