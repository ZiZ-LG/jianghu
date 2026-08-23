export const KNOWLEDGE_DOMAINS = [
  'ai_technology',
  'enterprise_sales',
  'role_org',
] as const;

export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

export const KNOWLEDGE_PATH_DAYS = [1, 7, 30, 90] as const;
export const LEGACY_FIELDBOOK_PATH_DAYS = [3, 7, 14, 30] as const;

export const FIRST_RELEASE_REQUIREMENTS = {
  knowledgeItems: 30,
  topics: 6,
  tools: 8,
  homepageItems: { min: 3, max: 5 },
  weeklyUpdates: { min: 3, max: 5 },
  fullChineseRequired: true,
  englishBodyRequired: false,
  seedReview: 'manual',
  toolOutputs: ['editable', 'copy', 'markdown_download'],
} as const;

export const INTEGRATION_BOUNDARIES = {
  crmWrite: false,
  portfolioGenerator: false,
  publicProfile: false,
  cloudToolStorage: false,
} as const;

export interface LocalizedText {
  readonly zh: string;
  readonly en?: string;
}

export type ContentKind =
  | 'update'
  | 'event'
  | 'explainer'
  | 'case'
  | 'method'
  | 'tool'
  | 'role'
  | 'learning_path';

export const EVIDENCE_LEVELS = [
  'official',
  'multi_source',
  'single_source',
  'practitioner_opinion',
  'editorial_inference',
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export type RiskLevel = 'low' | 'medium' | 'high';
export type PublicationMode = 'manual' | 'allowlisted_low_risk_auto';
export type EditorialStatus = 'candidate' | 'approved' | 'archived';

export interface EvidenceRef {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly level: EvidenceLevel;
  readonly language: 'zh' | 'en';
  readonly allowlisted: boolean;
  readonly dateBasis?: 'published' | 'last_updated' | 'observed';
}

export interface PublicationAudit {
  readonly sourceFingerprint: string;
  readonly ruleVersion: string;
  readonly processedAt: string;
  readonly releaseVersion: string;
  readonly rollbackState: 'available' | 'rolled_back';
}

export interface KnowledgeItem {
  readonly id: string;
  readonly slug: string;
  readonly title: LocalizedText;
  readonly summary: LocalizedText;
  readonly kind: ContentKind;
  readonly domains: readonly KnowledgeDomain[];
  readonly topicSlugs: readonly string[];
  readonly audience: readonly (
    | 'transitioning_seller'
    | 'ai_ae'
    | 'sales_leader'
    | 'solution'
    | 'customer_success'
  )[];
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly freshness: 'breaking' | 'current' | 'evergreen';
  readonly whyItMatters: LocalizedText;
  readonly salesImplication: LocalizedText;
  readonly roleOrgImplication: LocalizedText;
  readonly nextAction: LocalizedText;
  readonly evidence: readonly EvidenceRef[];
  readonly relatedItemIds: readonly string[];
  readonly editorialStatus: EditorialStatus;
  readonly riskLevel: RiskLevel;
  readonly publicationMode: PublicationMode;
  readonly seedContent: boolean;
  readonly audit: PublicationAudit;
}

export type SeedContentCategory =
  | 'ai_technology'
  | 'enterprise_sales_method'
  | 'ai_role_change'
  | 'org_adoption';

export interface SeedReview {
  readonly status: 'pending_owner_review' | 'approved' | 'changes_requested';
  readonly verifiedAt: string;
  readonly changeWindow: 'within_30_days' | 'within_90_days' | 'evergreen';
  readonly factType:
    | 'official_fact'
    | 'company_claim'
    | 'research_finding'
    | 'editorial_inference';
  readonly verificationNotes: string;
}

export interface SeedCandidate extends KnowledgeItem {
  readonly seedCategory: SeedContentCategory;
  readonly originalTitle?: string;
  readonly tags: readonly string[];
  readonly toolIds: readonly string[];
  readonly review: SeedReview;
}

export interface KnowledgeTopic {
  readonly slug: string;
  readonly title: LocalizedText;
  readonly summary: LocalizedText;
  readonly domains: readonly KnowledgeDomain[];
  readonly itemIds: readonly string[];
  readonly problemDefinition: LocalizedText;
  readonly keyChanges: LocalizedText;
  readonly salesJudgment: LocalizedText;
  readonly roleOrgImpact: LocalizedText;
  readonly toolIds: readonly string[];
}

export interface KnowledgeTool {
  readonly id: string;
  readonly title: LocalizedText;
  readonly scenario: LocalizedText;
  readonly estimatedMinutes: number;
  readonly outputFormat: 'markdown';
  readonly inputPrompts: readonly LocalizedText[];
  readonly templateMarkdown: string;
  readonly exampleMarkdown: string;
  readonly completionCriteria: readonly LocalizedText[];
  readonly safetyNote: LocalizedText;
}

export interface ToolMaterial {
  readonly toolId: string;
  readonly title: string;
  readonly status: 'not_started' | 'in_progress' | 'completed';
  readonly bodyMarkdown: string;
  readonly updatedAt: string;
}

export interface LocalLibraryState {
  readonly version: 1;
  readonly bookmarkedIds: readonly string[];
  readonly readIds: readonly string[];
  readonly toolMaterials: readonly ToolMaterial[];
  readonly updatedAt: string;
}
