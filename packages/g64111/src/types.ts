export type Role = 'A' | 'D' | 'U' | 'R' | 'C';
export type Sentiment = 'star' | 'plus' | 'neutral' | 'unknown' | 'minus' | 'x';
export type Confidence = '共识' | '明确' | '推理' | '不清';
export type EngageStage = '需求调研立项' | '方案可研' | '预算批复' | '招标论证' | '招采执行';
export type ProcurementType = 'purchasing' | 'agency' | 'ownerRep';
export type ProcurementStatus = 'collude' | 'verbal' | 'none';

export type Band741 =
  | 'ABSOLUTE_ADVANTAGE'
  | 'RELATIVE_ADVANTAGE'
  | 'RELATIVE_DISADVANTAGE'
  | 'ABSOLUTE_DISADVANTAGE';

export type ItemKey = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'P1' | 'P2' | 'P3' | 'P4' | '1K';

export interface ScoringProfile {
  id: string;
  name: string;
  formC1Curve: 'strict' | 'linear';
  bands: { absAdv: number; relAdv: number; relDis: number };
}

export interface ScoringForm {
  family7?: Record<string, unknown>;
}

export interface ScoringPerson {
  id: string;
  form?: ScoringForm;
}

export interface ScoringRole {
  personId: string;
  role: Role;
  sentiment: Sentiment;
  confidence: Confidence;
  isKeyInfluencer?: boolean;
  procurementType?: ProcurementType;
  procurementStatus?: ProcurementStatus;
}

export interface ScoringBurningIssue {
  id: string;
  personId: string;
  confidence: Confidence;
}

export interface ScoringUcv {
  targetBiId: string;
  status: '建议' | '获认可' | '已解决';
}

export interface ScoringOpportunity {
  primaryDPersonId?: string | null;
  engageStage?: EngageStage | string | null;
  c3Items?: Record<string, unknown>;
  c5Items?: Record<string, unknown>;
  roles?: readonly ScoringRole[];
  bis?: readonly ScoringBurningIssue[];
  ucvs?: readonly ScoringUcv[];
}

export interface ScoringAccount {
  persons?: readonly ScoringPerson[];
}

export interface ScoringInput {
  rolesPresent: Record<Role, boolean>;
  nonAUnknownCount: number;
  procurementTypesIdentified: number;
  dFamily7Filled: number;
  dHasBI: boolean;
  c3KnownCount: number;
  engageStage: EngageStage | null;
  c5KnownCount: number;
  ucvStatus: 'none' | '建议' | '获认可' | '已解决';
  p1PlusCount: number;
  p1MinusCount: number;
  p2: Record<ProcurementType, ProcurementStatus>;
  dSentiments: Sentiment[];
  aSentiments: Sentiment[];
  keyInfluencerSentiment: Sentiment | null;
}

export interface ScoreBreakdown {
  items: Record<ItemKey, number>;
  clears: number;
  priorities: number;
  key: number;
  total: number;
  percent: number;
  band: Band741;
  bandLabel: string;
  strategy: string;
}

export interface ContributionPart {
  item: ItemKey;
  value: number;
  note?: string;
}

export interface PersonContribution {
  nominal: number;
  potential: number;
  upside: number;
  parts: ContributionPart[];
}
