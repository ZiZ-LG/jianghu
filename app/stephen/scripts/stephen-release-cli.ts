/// <reference path="./node-runtime.d.ts" />

import {
  parseStephenReleaseCliArgs,
  verifyStephenArtifactDirectory,
} from './stephen-release.ts';

async function main() {
  const command = parseStephenReleaseCliArgs(process.argv.slice(2));
  const metadata = await verifyStephenArtifactDirectory({
    artifactDirectory: command.artifactDirectory,
    sourceSha: command.sourceSha,
    metadataFile: command.metadataFile,
  });
  process.stdout.write(`${JSON.stringify({
    task: metadata.task,
    sourceSha: metadata.sourceSha,
    fileCount: metadata.fileCount,
    contentChecksum: metadata.contentChecksum,
    metadataFile: command.metadataFile,
    smokePaths: metadata.smokePaths,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown SAAS-607 release error';
  process.stderr.write(`SAAS607_RELEASE_ERROR=${message}\n`);
  process.exitCode = 1;
});
