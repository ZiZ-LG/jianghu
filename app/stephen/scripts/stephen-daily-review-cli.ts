import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  buildDailyReviewArtifacts,
  dailyReviewContext,
  parseDailyReviewCliArgs,
  resolveDraftPrAction,
  resolveReviewOutputPath,
} from './stephen-daily-review.ts';

function parentDirectory(path: string) {
  const separator = path.lastIndexOf('/');
  if (separator <= 0) throw new Error('output file must have a parent directory');
  return path.slice(0, separator);
}

function isMissingFile(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readOptionalJson(path: string) {
  try {
    return await readJson(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(parentDirectory(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 300);
  return 'unknown SAAS-606 error';
}

async function main() {
  const command = parseDailyReviewCliArgs(process.argv.slice(2));
  if (command.command === 'context') {
    process.stdout.write(`${JSON.stringify(dailyReviewContext(command))}\n`);
    return;
  }
  if (command.command === 'resolve-pr') {
    const value = await readJson(command.prsFile);
    if (!Array.isArray(value)) throw new Error('PR query result must be an array');
    process.stdout.write(`${JSON.stringify(resolveDraftPrAction(value))}\n`);
    return;
  }
  if (command.command === 'validate-workflow') {
    const { validateDailyIntakeWorkflow } = await import('./stephen-daily-review.ts');
    process.stdout.write(`${JSON.stringify(validateDailyIntakeWorkflow(
      await readFile(command.workflowFile, 'utf8'),
    ))}\n`);
    return;
  }

  const context = dailyReviewContext(command);
  const manifestPath = resolveReviewOutputPath(command.outputRoot, context.manifestPath);
  const ledgerPath = resolveReviewOutputPath(command.outputRoot, context.ledgerPath);
  const bodyPath = resolveReviewOutputPath(command.outputRoot, command.bodyFile);
  const artifacts = buildDailyReviewArtifacts({
    report: await readJson(command.reportPath),
    editorialDate: command.editorialDate,
    mode: command.mode,
    existingManifest: await readOptionalJson(manifestPath),
    existingLedger: await readOptionalJson(ledgerPath),
  });

  await writeJson(manifestPath, artifacts.manifest);
  await writeJson(ledgerPath, artifacts.ledger);
  await mkdir(parentDirectory(bodyPath), { recursive: true });
  await writeFile(bodyPath, artifacts.prBody, 'utf8');
  process.stdout.write(`${JSON.stringify({
    task: 'SAAS-606',
    ...artifacts.context,
    summary: artifacts.summary,
    proposedCount: artifacts.manifest.candidates.length,
    shouldOpenPr: artifacts.manifest.candidates.length > 0,
    bodyFile: command.bodyFile,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    task: 'SAAS-606',
    error: safeErrorMessage(error),
  })}\n`);
  process.exitCode = 1;
});
