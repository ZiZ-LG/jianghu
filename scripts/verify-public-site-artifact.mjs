#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, extname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = resolve(repoRoot, 'deploy/public-site-targets.json');
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.svg', '.txt', '.xml']);
const maximumFileBytes = 32 * 1024 * 1024;
const maximumArtifactBytes = 256 * 1024 * 1024;

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = { forDeploy: false };
  const valueOptions = new Set([
    '--site',
    '--artifact',
    '--source-dir',
    '--source-sha',
    '--build-command',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--for-deploy') {
      if (options.forDeploy) fail('duplicate --for-deploy');
      options.forDeploy = true;
      continue;
    }
    if (!valueOptions.has(argument)) fail(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (options[key] !== undefined) fail(`duplicate ${argument}`);
    options[key] = value;
    index += 1;
  }
  for (const key of ['site', 'artifact', 'sourceDir', 'sourceSha', 'buildCommand']) {
    if (!options[key]) fail(`missing required argument: ${key}`);
  }
  if (!/^[0-9a-f]{40}$/.test(options.sourceSha)) fail('source SHA must be a lowercase 40-character Git SHA');
  if (options.buildCommand.length > 512 || /[\x00-\x1f\x7f]/.test(options.buildCommand)) {
    fail('build command must be one printable line of at most 512 characters');
  }
  if (/(?:password|secret|token|api[_-]?key|private[_-]?key)\s*=/i.test(options.buildCommand)) {
    fail('build command appears to contain a secret and will not be printed');
  }
  if (/(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(options.buildCommand)) {
    fail('build commands with inline environment assignments will not be printed');
  }
  return options;
}

function loadTarget(siteId) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    fail('public-site target registry is missing or invalid');
  }
  if (registry?.schemaVersion !== 1 || !registry.targets || typeof registry.targets !== 'object') {
    fail('public-site target registry has an unsupported schema');
  }
  const target = registry.targets[siteId];
  if (!target) fail(`unknown site target: ${siteId}`);
  return target;
}

function runGit(sourceDir, args) {
  const result = spawnSync('git', ['-C', sourceDir, ...args], { encoding: 'utf8' });
  if (result.status !== 0) fail('source directory is not a readable Git worktree');
  return result.stdout.trim();
}

function verifySourceProvenance(sourceDirInput, sourceSha) {
  let sourceDir;
  try {
    const inputStat = lstatSync(sourceDirInput);
    if (inputStat.isSymbolicLink()) fail('source directory must not be a symbolic link');
    if (!inputStat.isDirectory()) fail('source directory is not a directory');
    sourceDir = realpathSync(sourceDirInput);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('source directory')) throw error;
    fail('source directory does not exist');
  }
  const head = runGit(sourceDir, ['rev-parse', 'HEAD']);
  if (head !== sourceSha) fail('source HEAD does not match source SHA');
  const status = runGit(sourceDir, ['status', '--porcelain', '--untracked-files=all']);
  if (status !== '') fail('source worktree is dirty');
  return sourceDir;
}

function collectArtifactFiles(artifactDir) {
  const files = [];
  let totalBytes = 0;

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const absolutePath = resolve(directory, entry.name);
      const stat = lstatSync(absolutePath);
      const relativePath = relative(artifactDir, absolutePath).split(sep).join('/');
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) fail(`artifact contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !stat.isFile()) fail(`artifact contains a non-regular file: ${relativePath}`);
      if (stat.size > maximumFileBytes) fail(`artifact file exceeds size limit: ${relativePath}`);
      totalBytes += stat.size;
      if (totalBytes > maximumArtifactBytes) fail('artifact exceeds total size limit');
      files.push({ absolutePath, relativePath, size: stat.size });
    }
  }

  visit(artifactDir);
  return files.sort((left, right) => compareText(left.relativePath, right.relativePath));
}

function resolveArtifactDirectory(artifactInput) {
  let artifactDir;
  try {
    const inputStat = lstatSync(artifactInput);
    if (inputStat.isSymbolicLink()) fail('artifact directory must not be a symbolic link');
    if (!inputStat.isDirectory()) fail('artifact path is not a directory');
    artifactDir = realpathSync(artifactInput);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('artifact')) throw error;
    fail('artifact directory does not exist');
  }
  return artifactDir;
}

function extractTitle(indexHtml) {
  const match = indexHtml.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  if (!match) fail('artifact index.html has no title');
  return match[1].replace(/\s+/g, ' ').trim();
}

function verifyReferencedAssets(indexHtml, artifactDir, artifactFiles) {
  const available = new Set(artifactFiles.map((file) => file.relativePath));
  const references = [...indexHtml.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]);
  for (const rawReference of references) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(rawReference)) continue;
    const withoutQuery = rawReference.split(/[?#]/, 1)[0];
    let decoded;
    try {
      decoded = decodeURIComponent(withoutQuery);
    } catch {
      fail(`artifact contains an invalid asset URL: ${rawReference}`);
    }
    const normalized = posix.normalize(decoded.replace(/^\/+/, ''));
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      fail(`artifact contains an unsafe asset URL: ${rawReference}`);
    }
    if (!available.has(normalized)) fail(`referenced asset is missing: ${normalized}`);
    const resolved = resolve(artifactDir, normalized);
    if (resolved !== artifactDir && !resolved.startsWith(`${artifactDir}${sep}`)) {
      fail(`artifact asset escapes its root: ${rawReference}`);
    }
  }
}

function verifyIdentity(target, artifactFiles) {
  const indexFile = artifactFiles.find((file) => file.relativePath === 'index.html');
  if (!indexFile) fail('artifact is missing index.html');
  const indexHtml = readFileSync(indexFile.absolutePath, 'utf8');
  const title = extractTitle(indexHtml);
  if (title !== target.artifactIdentity.title) {
    fail(`artifact title mismatch: expected ${target.artifactIdentity.title}, got ${title}`);
  }
  verifyReferencedAssets(indexHtml, dirname(indexFile.absolutePath), artifactFiles);

  const text = artifactFiles
    .filter((file) => textExtensions.has(extname(file.relativePath).toLowerCase()))
    .map((file) => readFileSync(file.absolutePath, 'utf8'))
    .join('\n');
  for (const marker of target.artifactIdentity.requiredMarkers) {
    if (!text.includes(marker)) fail(`artifact is missing required marker: ${marker}`);
  }
  for (const url of target.artifactIdentity.requiredUrls) {
    if (!text.includes(url)) fail(`artifact is missing required URL: ${url}`);
  }
  let orderedMarkerCursor = 0;
  for (const marker of target.artifactIdentity.orderedMarkers ?? []) {
    const markerIndex = text.indexOf(marker, orderedMarkerCursor);
    if (markerIndex < 0) fail(`artifact violates required marker order at: ${marker}`);
    orderedMarkerCursor = markerIndex + marker.length;
  }
  for (const marker of target.artifactIdentity.forbiddenMarkers) {
    if (text.includes(marker)) fail(`artifact contains forbidden marker: ${marker}`);
  }
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh\b/i.test(indexHtml)
      || /(?:window\s*\.\s*)?location\s*\.\s*(?:replace|assign)\s*\(/i.test(text)
      || /(?:window\s*\.\s*)?location\s*(?:\.\s*href)?\s*=(?!=)/i.test(text)) {
    fail('artifact contains automatic navigation');
  }
  return title;
}

function checksumArtifact(artifactFiles) {
  const directoryHash = createHash('sha256');
  for (const file of artifactFiles) {
    const fileHash = createHash('sha256').update(readFileSync(file.absolutePath)).digest('hex');
    directoryHash.update(file.relativePath);
    directoryHash.update('\0');
    directoryHash.update(String(file.size));
    directoryHash.update('\0');
    directoryHash.update(fileHash);
    directoryHash.update('\n');
  }
  return directoryHash.digest('hex');
}

function deploymentBlockReason(siteId, target) {
  if (target.deployment.manager !== 'public-edge-release-guard') {
    return `${siteId} is not managed by the public-edge release guard`;
  }
  const reasons = [];
  if (target.source.authority !== 'authoritative') reasons.push('source authority is unresolved');
  if (target.deployment.atomicRuntimeAuthority !== true) reasons.push('atomic runtime authority is unavailable');
  return reasons.length > 0 ? `${siteId} deployment is blocked: ${reasons.join('; ')}` : null;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const target = loadTarget(options.site);
  verifySourceProvenance(options.sourceDir, options.sourceSha);
  const artifactDir = resolveArtifactDirectory(options.artifact);
  const artifactFiles = collectArtifactFiles(artifactDir);
  const title = verifyIdentity(target, artifactFiles);
  const artifactChecksum = checksumArtifact(artifactFiles);
  const blockReason = deploymentBlockReason(options.site, target);
  if (options.forDeploy && blockReason) fail(blockReason);

  console.log(JSON.stringify({
    siteId: options.site,
    sourceSha: options.sourceSha,
    buildCommand: options.buildCommand,
    artifactPath: artifactDir,
    artifactChecksum,
    destinationHost: target.deployment.destinationHost,
    destinationPath: target.deployment.destinationPath,
    canonicalUrl: target.canonicalUrl,
    title,
    deployAllowed: blockReason === null,
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown verifier failure';
  console.error(`PUBLIC_SITE_ARTIFACT_ERROR=${message}`);
  process.exitCode = 1;
}
