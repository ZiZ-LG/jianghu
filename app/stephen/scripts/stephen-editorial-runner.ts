import type { EditorialIntakeHistory } from '../src/content/intake.ts';

interface EditorialScanSource {
  readonly id: string;
}

interface EditorialScanStep<TReport> {
  readonly report: TReport;
  readonly nextHistory: EditorialIntakeHistory;
}

export interface SequentialEditorialScanResult<TReport> {
  readonly reports: readonly TReport[];
  readonly failures: readonly {
    readonly sourceId: string;
    readonly error: unknown;
  }[];
  readonly nextHistory: EditorialIntakeHistory;
}

export async function runSequentialEditorialScans<
  TSource extends EditorialScanSource,
  TReport,
>(
  sources: readonly TSource[],
  scan: (
    source: TSource,
    history: EditorialIntakeHistory,
  ) => Promise<EditorialScanStep<TReport>>,
): Promise<SequentialEditorialScanResult<TReport>> {
  const reports: TReport[] = [];
  const failures: { sourceId: string; error: unknown }[] = [];
  let history: EditorialIntakeHistory = {};

  for (const source of sources) {
    try {
      const result = await scan(source, history);
      reports.push(result.report);
      history = result.nextHistory;
    } catch (error) {
      failures.push({ sourceId: source.id, error });
    }
  }

  return {
    reports,
    failures,
    nextHistory: history,
  };
}
