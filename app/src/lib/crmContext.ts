import type {
  CrmContextSnapshot,
  CustomerV2,
  MatterV2,
  PersonSummaryV2,
  RelationV2,
} from '@jianghu/domain-contracts';

const CUSTOMER_CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  strategic_partner: '战略合作',
  partner: '合作伙伴',
  customer: '客户',
  prospect: '潜在客户',
});

const MATTER_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  general: '通用事项',
  sales_opportunity: '销售事项',
});

const MATTER_LIFECYCLE_LABELS: Readonly<Record<MatterV2['lifecycleStatus'], string>> = Object.freeze({
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  canceled: '已取消',
});

const RELATION_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  related: '有关联',
  reports_to: '汇报关系',
  collaborates_with: '协作关系',
  trusted_advisor: '信任顾问',
  introduced_by: '由其引荐',
});

export function customerCategoryLabel(categoryKey: string | null): string {
  if (categoryKey === null) return '未分类';
  return CUSTOMER_CATEGORY_LABELS[categoryKey] ?? `自定义分类 · ${categoryKey}`;
}

export function matterKindLabel(kind: string): string {
  return MATTER_KIND_LABELS[kind] ?? `自定义事项 · ${kind}`;
}

export function matterLifecycleLabel(status: MatterV2['lifecycleStatus']): string {
  return MATTER_LIFECYCLE_LABELS[status];
}

export function relationKindLabel(kind: string): string {
  return RELATION_KIND_LABELS[kind] ?? `自定义关系 · ${kind}`;
}

export interface CustomerContext {
  customer: CustomerV2;
  matters: MatterV2[];
  people: PersonSummaryV2[];
  relations: RelationV2[];
}

export interface MatterContext {
  customer: CustomerV2;
  matter: MatterV2;
  participants: PersonSummaryV2[];
  people: PersonSummaryV2[];
  relations: RelationV2[];
}

export function selectCustomerContext(
  snapshot: CrmContextSnapshot,
  customerId: string,
): CustomerContext | null {
  const customer = snapshot.customers.find((candidate) => candidate.id === customerId);
  if (!customer) return null;
  return {
    customer,
    matters: snapshot.matters.filter((matter) => matter.customerId === customerId),
    people: snapshot.people.filter((person) => person.customerId === customerId),
    relations: snapshot.relations.filter((relation) => (
      relation.customerId === customerId && relation.matterId === null
    )),
  };
}

export function selectMatterContext(
  snapshot: CrmContextSnapshot,
  matterId: string,
): MatterContext | null {
  const matter = snapshot.matters.find((candidate) => candidate.id === matterId);
  if (!matter) return null;
  const customer = snapshot.customers.find((candidate) => candidate.id === matter.customerId);
  if (!customer) return null;

  const participantIds = new Set(
    snapshot.matterParticipants
      .filter((participant) => participant.matterId === matterId)
      .map((participant) => participant.personId),
  );
  const relations = snapshot.relations
    .filter((relation) => relation.customerId === customer.id
      && (relation.matterId === null || relation.matterId === matterId))
    .sort((left, right) => {
      const scopeOrder = Number(left.matterId !== null) - Number(right.matterId !== null);
      return scopeOrder || left.id.localeCompare(right.id);
    });
  const visiblePersonIds = new Set(participantIds);
  for (const relation of relations) {
    visiblePersonIds.add(relation.sourcePersonId);
    visiblePersonIds.add(relation.targetPersonId);
  }
  const customerPeople = snapshot.people.filter((person) => person.customerId === customer.id);

  return {
    customer,
    matter,
    participants: customerPeople.filter((person) => participantIds.has(person.id)),
    people: customerPeople.filter((person) => visiblePersonIds.has(person.id)),
    relations,
  };
}
