import { useId, useMemo } from 'react';
import type { RelationshipWorkspaceResponse, RelationV2 } from '@jianghu/domain-contracts';

type CandidateRelation = RelationshipWorkspaceResponse['candidateRelations'][number];
type HypothesisProjection = RelationshipWorkspaceResponse['hypotheses'][number];
type Person = RelationshipWorkspaceResponse['people'][number];

interface GraphNode {
  id: string;
  label: string;
  title: string | null;
  candidate: boolean;
}

const candidateNodeId = (id: string) => `candidate:${id}`;

function endpointNodeId(endpoint: CandidateRelation['sourceEndpoint']): string {
  return endpoint.kind === 'person' ? endpoint.personId : candidateNodeId(endpoint.candidateId);
}

function graphPositions(nodes: readonly GraphNode[]) {
  const width = 640;
  const height = 320;
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = 245;
  const radiusY = 108;
  return new Map(nodes.map((node, index) => {
    if (nodes.length === 1) return [node.id, { x: centerX, y: centerY }] as const;
    const angle = (-Math.PI / 2) + ((2 * Math.PI * index) / nodes.length);
    return [node.id, {
      x: centerX + (Math.cos(angle) * radiusX),
      y: centerY + (Math.sin(angle) * radiusY),
    }] as const;
  }));
}

export function CrmRelationshipGraph({
  people,
  formalRelations,
  candidateRelations = [],
  hypotheses = [],
  showCandidates = false,
  showHypotheses = false,
  focusPersonId = null,
  title,
  selectedPersonId,
  selectedRelationId,
  onSelectPerson,
  onSelectRelation,
}: {
  people: readonly Person[];
  formalRelations: readonly RelationV2[];
  candidateRelations?: readonly CandidateRelation[];
  hypotheses?: readonly HypothesisProjection[];
  showCandidates?: boolean;
  showHypotheses?: boolean;
  focusPersonId?: string | null;
  title: string;
  selectedPersonId?: string;
  selectedRelationId?: string;
  onSelectPerson?: (id: string) => void;
  onSelectRelation?: (id: string) => void;
}) {
  const titleId = useId();
  const markerSuffix = useId().split(':').join('');
  const formalMarkerId = `crm-formal-arrow-${markerSuffix}`;
  const candidateMarkerId = `crm-candidate-arrow-${markerSuffix}`;
  const nodes = useMemo(() => {
    const result: GraphNode[] = people.map((person) => ({
      id: person.id,
      label: person.name,
      title: person.title,
      candidate: false,
    }));
    const seen = new Set(result.map((node) => node.id));
    if (showCandidates) {
      candidateRelations.forEach((relation) => {
        [relation.sourceEndpoint, relation.targetEndpoint].forEach((endpoint) => {
          if (endpoint.kind !== 'candidate_person') return;
          const id = candidateNodeId(endpoint.candidateId);
          if (seen.has(id)) return;
          seen.add(id);
          result.push({ id, label: endpoint.label, title: endpoint.title, candidate: true });
        });
      });
    }
    return result;
  }, [candidateRelations, people, showCandidates]);
  const positions = useMemo(() => graphPositions(nodes), [nodes]);

  return (
    <div className="crm-relation-canvas">
      <svg viewBox="0 0 640 320" role={onSelectPerson || onSelectRelation ? 'group' : 'img'} aria-labelledby={titleId} preserveAspectRatio="xMidYMid meet">
        <title id={titleId}>{title}</title>
        <defs>
          <marker id={formalMarkerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="crm-relation-arrow" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
          <marker id={candidateMarkerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="crm-relation-candidate-arrow" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>

        {formalRelations.map((relation) => {
          const source = positions.get(relation.sourcePersonId);
          const target = positions.get(relation.targetPersonId);
          if (!source || !target) return null;
          const distance = Math.hypot(target.x - source.x, target.y - source.y) || 1;
          const normalX = -(target.y - source.y) / distance * 12;
          const normalY = (target.x - source.x) / distance * 12;
          const label = `${nodes.find(node => node.id === relation.sourcePersonId)?.label} ${relation.directed ? '→' : '—'} ${nodes.find(node => node.id === relation.targetPersonId)?.label}：${relation.label ?? '关系待说明'}`;
          return <g key={relation.id} data-relation-id={relation.id} data-relation-layer="formal"
            role={onSelectRelation ? 'button' : undefined} tabIndex={onSelectRelation ? 0 : undefined}
            aria-label={label} aria-pressed={onSelectRelation ? selectedRelationId === relation.id : undefined}
            onClick={() => onSelectRelation?.(relation.id)}
            onKeyDown={event => { if (onSelectRelation && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelectRelation(relation.id); } }}>
            <title>{label}</title>
            {onSelectRelation ? <path className="personal-relation-hit" d={`M ${source.x + normalX} ${source.y + normalY} L ${target.x + normalX} ${target.y + normalY} L ${target.x - normalX} ${target.y - normalY} L ${source.x - normalX} ${source.y - normalY} Z`} /> : null}
            <line
              className={`crm-relation-line${selectedRelationId === relation.id ? ' selected' : ''}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              markerEnd={relation.directed ? `url(#${formalMarkerId})` : undefined}
            />
          </g>;
        })}

        {showCandidates && candidateRelations.map((relation) => {
          const source = positions.get(endpointNodeId(relation.sourceEndpoint));
          const target = positions.get(endpointNodeId(relation.targetEndpoint));
          if (!source || !target) return null;
          return <g key={relation.candidateId} data-relation-id={relation.candidateId} data-relation-layer="candidate">
            <line
              className="crm-relation-candidate-line"
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              markerEnd={relation.directed ? `url(#${candidateMarkerId})` : undefined}
            />
            <text className="crm-relation-candidate-question" x={(source.x + target.x) / 2} y={(source.y + target.y) / 2}>?</text>
          </g>;
        })}

        {showHypotheses && hypotheses.map(({ hypothesis }) => {
          if (!hypothesis.personId) return null;
          const position = positions.get(hypothesis.personId);
          if (!position) return null;
          return <g
            key={hypothesis.id}
            className="crm-hypothesis-annotation"
            data-hypothesis-layer="dotted"
            transform={`translate(${position.x + 42} ${position.y - 42})`}
          >
            <path d="M -10 32 L 0 18" />
            <rect x="0" y="0" width="210" height="38" rx="8" />
            <text x="10" y="23">{hypothesis.currentRevision.claim}</text>
          </g>;
        })}

        {nodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const focused = !node.candidate && node.id === focusPersonId;
          return <g
            key={node.id}
            className={`crm-relation-node${node.candidate ? ' candidate' : ''}${focused ? ' focused' : ''}`}
            data-focus-person={focused ? 'true' : undefined}
            data-person-id={node.candidate ? undefined : node.id}
            role={!node.candidate && onSelectPerson ? 'button' : undefined}
            tabIndex={!node.candidate && onSelectPerson ? 0 : undefined}
            aria-label={`${node.candidate ? '待审核人物：' : ''}${node.label} · ${node.title ?? '职务待核实'}`}
            aria-pressed={!node.candidate && onSelectPerson ? selectedPersonId === node.id : undefined}
            onClick={() => { if (!node.candidate) onSelectPerson?.(node.id); }}
            onKeyDown={event => { if (!node.candidate && onSelectPerson && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelectPerson(node.id); } }}
            transform={`translate(${position.x} ${position.y})`}
          >
            <title>{node.label} · {node.title ?? '职务待核实'}</title>
            <circle r="34" />
            <text textAnchor="middle" dominantBaseline="middle">{node.label.slice(0, 6)}</text>
            {node.title ? <text className="crm-relation-node-title" textAnchor="middle" y="53">{node.title.slice(0, 12)}</text> : null}
            {node.candidate ? <text className="crm-relation-node-question" textAnchor="middle" x="27" y="-24">?</text> : null}
          </g>;
        })}
      </svg>
    </div>
  );
}
