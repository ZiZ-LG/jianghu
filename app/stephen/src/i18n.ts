import type { KnowledgeDomain, LocalizedText } from './domain';

export type Language = 'zh' | 'en';

export function localize(value: LocalizedText, language: Language) {
  return language === 'en' && value.en ? value.en : value.zh;
}

export function isChineseFallback(value: LocalizedText, language: Language) {
  return language === 'en' && !value.en;
}

export const domainLabels: Readonly<Record<KnowledgeDomain, LocalizedText>> = {
  ai_technology: { zh: 'AI 技术', en: 'AI Technology' },
  enterprise_sales: { zh: '大客户销售', en: 'Enterprise Sales' },
  role_org: { zh: '岗位与组织', en: 'Roles & Organization' },
};
