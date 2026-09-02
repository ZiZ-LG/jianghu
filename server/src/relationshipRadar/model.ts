export interface RadarInteractionFact {
  id: string;
  version: number;
  occurredAtUtc: string;
}

export interface RadarParticipantFact {
  id: string;
  personId: string;
}

export interface RadarRelationFact {
  id: string;
  sourcePersonId: string;
  targetPersonId: string;
  version: number;
  directed: boolean;
}

export interface RadarEvidenceFact {
  id: string;
  personId: string | null;
  occurredAtUtc: string;
}

export interface RadarIntelligenceFact {
  id: string;
  version: number;
  targetPersonIds: readonly string[];
  learnedAtUtc: string;
}

export interface RadarFocusFact {
  id: string;
  personId: string;
  version: number;
  confirmedAtUtc: string;
}

export interface RadarCommitmentFact {
  id: string;
  personId: string | null;
  version: number;
  scheduleVersion: number;
  executionStatus: 'planned' | 'completed';
  indicatorAtUtc: string;
}

/** Body-free, tenant-scoped facts accepted by the deterministic V1 rule engine. */
export interface RelationshipRadarFacts {
  tenantId: string;
  customerId: string;
  customerVersion: number;
  matterId: string;
  matterVersion: number;
  generatedAtUtc: string;
  interactions: readonly RadarInteractionFact[];
  participants: readonly RadarParticipantFact[];
  relations: readonly RadarRelationFact[];
  evidence: readonly RadarEvidenceFact[];
  intelligence: readonly RadarIntelligenceFact[];
  focus: RadarFocusFact | null;
  commitments: readonly RadarCommitmentFact[];
}
