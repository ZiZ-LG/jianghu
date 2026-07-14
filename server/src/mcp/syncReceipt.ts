export interface SyncReceipt {
  syncRunId: string;
  replayed: boolean;
  created: string[];
  updated: string[];
  proposed: string[];
  skipped: Array<{ ref: string; reason: string }>;
  failed: Array<{ ref: string; code: string; message: string }>;
}

export type StoredSyncReceipt = Omit<SyncReceipt, 'replayed'>;

export const replayReceipt = (receipt: StoredSyncReceipt): SyncReceipt => ({ ...receipt, replayed: true });
