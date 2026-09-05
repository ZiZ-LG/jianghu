import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PersonalWorkbenchDetail } from '@jianghu/domain-contracts';
import { RELATIONSHIP_WORKSPACE_FIXTURE as workspace } from '../testFixtures/relationshipWorkspace';
import { PersonalMapWorkspace, PersonalEvidenceList } from './PersonalMapWorkspace';
import { PersonalActionForm } from './PersonalMapForms';

const detail: PersonalWorkbenchDetail = {
  opportunity: { matter: workspace.matter, customerBusinessGoal: null, salesProgress: null }, workspace,
  participants: workspace.people.map(person => ({ personId: person.id, version: 0, decisionRole: null, basis: null, basisState: 'unverified' })),
  availablePeople: workspace.people, commitments: [],
};
const render = (readonly: boolean) => renderToStaticMarkup(createElement(PersonalMapWorkspace, { detail, readonly, actorUserId: 'owner-208', onRefresh: async () => undefined, onToday: () => undefined }));

describe('personal map boundaries', () => {
  it('starts on an accessible map with known people only and no submitted action form', () => {
    const html = render(false);
    expect(html).toContain('data-person-id="person-a-208"');
    expect(html).toContain('role="group"');
    expect(html).toContain('建立行动草稿');
    expect(html).not.toContain('赵经理');
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/G64111|赢率|总分/);
  });
  it('keeps viewer reading and selection without any formal write affordance', () => {
    const html = render(true);
    expect(html).toContain('data-person-id="person-a-208"');
    expect(html).not.toContain('加入已知人物</button>');
    expect(html).not.toContain('建立行动草稿</button>');
    expect(html).not.toContain('补充依据</button>');
  });
  it('labels a recorded statement as reported and shows only supplied current evidence', () => {
    const html = renderToStaticMarkup(createElement(PersonalEvidenceList, { items: workspace.intelligence }));
    expect(html).toContain('转述 · 待核实');
    expect(html).toContain('人工会后记录');
    expect(renderToStaticMarkup(createElement(PersonalEvidenceList, { items: [] }))).not.toContain(workspace.intelligence[0].statement);
  });
  it('renders a draft with editable object, purpose, time and expected signal before confirmation', () => {
    const html = renderToStaticMarkup(createElement(PersonalActionForm, { detail, actorUserId: 'owner-208', personId: 'person-a-208', onSaved: () => undefined, onClose: () => undefined }));
    expect(html).toContain('行动草稿（尚未保存）');
    expect(html).toContain('value="person-a-208" selected');
    expect(html).toContain('希望得到什么结果或信号');
    expect(html).toContain('确认保存下一步');
  });
});
