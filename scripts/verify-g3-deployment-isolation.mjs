#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composePath = resolve(repoRoot, 'docker-compose.yml');
const composeVariables = new Set(
  [...readFileSync(composePath, 'utf8').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)]
    .map((match) => match[1]),
);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('expected --commercial-env and --internal-env');
    values.set(key, value);
  }
  const commercialEnv = values.get('--commercial-env');
  const internalEnv = values.get('--internal-env');
  if (!commercialEnv || !internalEnv || values.size !== 2) {
    throw new Error('expected --commercial-env and --internal-env');
  }
  return { commercialEnv, internalEnv };
}

function parseEnvFile(path) {
  const values = new Map();
  for (const rawLine of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`invalid environment entry in ${path}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function required(values, key, label) {
  const value = values.get(key);
  if (!value) throw new Error(`${label} is missing ${key}`);
  return value;
}

function renderCompose(label, envPath, values) {
  const project = required(values, 'COMPOSE_PROJECT_NAME', label);
  const environment = { ...process.env };
  for (const key of [
    ...composeVariables,
    'COMPOSE_FILE',
    'COMPOSE_PROFILES',
    'COMPOSE_PROJECT_NAME',
  ]) delete environment[key];

  const result = spawnSync('docker', [
    'compose', '--env-file', envPath, '-p', project, '-f', composePath,
    'config', '--format', 'json',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
  });
  if (result.status !== 0) throw new Error(`${label} docker compose config failed`);
  try {
    return { project, config: JSON.parse(result.stdout) };
  } catch {
    throw new Error(`${label} docker compose config returned invalid JSON`);
  }
}

function safeResourceSummary(label, rendered) {
  const network = rendered.config.networks?.default?.name;
  const volume = rendered.config.volumes?.pgdata?.name;
  if (!network || !volume) throw new Error(`${label} Compose config is missing isolated network or pgdata volume`);
  return [
    `${label}_project=${rendered.project}`,
    `${label}_network=${network}`,
    `${label}_pgdata=${volume}`,
  ];
}

function deploymentIdentity(label, values, rendered) {
  const config = rendered.config;
  const project = config.name;
  const network = config.networks?.default?.name;
  const volume = config.volumes?.pgdata?.name;
  const database = config.services?.db?.environment;
  const server = config.services?.server?.environment;
  const publishedPort = config.services?.web?.ports?.[0]?.published;
  const backupDirectory = config['x-backup-config']?.directory;
  if (project !== rendered.project) throw new Error(`${label} Compose project does not match COMPOSE_PROJECT_NAME`);
  if (!network || !volume || !database || !server || !publishedPort || !backupDirectory) {
    throw new Error(`${label} Compose config is missing an isolation boundary`);
  }
  return {
    project,
    network,
    volume,
    databaseIdentity: `${database.POSTGRES_USER}/${database.POSTGRES_DB}`,
    databasePassword: database.POSTGRES_PASSWORD,
    backupDirectory,
    backupSecret: required(values, 'BACKUP_MASTER_SECRET', label),
    jwtSecret: server.JWT_SECRET,
    aiSecret: server.AI_KEY_SECRET,
    publishedPort: String(publishedPort),
    edition: server.PRODUCT_EDITION,
    entitlements: server.PRODUCT_ENTITLEMENTS,
    customerCommands: server.CUSTOMER_COMMANDS_ENABLED,
    methodologyCommands: server.METHODOLOGY_COMMANDS_ENABLED,
  };
}

function assertPhysicalIsolation(commercial, internal) {
  const boundaries = [
    ['Compose project', 'project'],
    ['default network', 'network'],
    ['PostgreSQL volume', 'volume'],
    ['database identity', 'databaseIdentity'],
    ['database password', 'databasePassword'],
    ['backup directory', 'backupDirectory'],
    ['backup master secret', 'backupSecret'],
    ['JWT secret', 'jwtSecret'],
    ['AI key secret', 'aiSecret'],
    ['published port', 'publishedPort'],
  ];
  for (const [label, key] of boundaries) {
    if (commercial[key] === internal[key]) throw new Error(`commercial and internal reuse ${label}`);
  }
}

function assertG3Policies(commercial, internal) {
  if (commercial.edition !== 'commercial') throw new Error('commercial deployment must use commercial edition');
  if (internal.edition !== 'internal') throw new Error('internal deployment must use internal edition');
  if (commercial.entitlements !== '') throw new Error('commercial G3 deployment must use Free entitlements');
  for (const deployment of [commercial, internal]) {
    const configured = required(deployment.values, 'CUSTOMER_COMMANDS_ENABLED', deployment.label);
    if (configured !== '0' && configured !== '1') {
      throw new Error(`${deployment.label} CUSTOMER_COMMANDS_ENABLED must be 0 or 1`);
    }
    if (deployment.customerCommands !== configured) {
      throw new Error(`${deployment.label} Compose did not render CUSTOMER_COMMANDS_ENABLED from its env file`);
    }
  }
  if (commercial.methodologyCommands !== '0') {
    throw new Error('commercial G3 deployment must keep methodology commands disabled');
  }
}

try {
  const { commercialEnv, internalEnv } = parseArguments(process.argv.slice(2));
  const commercialValues = parseEnvFile(commercialEnv);
  const internalValues = parseEnvFile(internalEnv);
  const commercial = renderCompose('commercial', commercialEnv, commercialValues);
  const internal = renderCompose('internal', internalEnv, internalValues);
  const commercialIdentity = {
    ...deploymentIdentity('commercial', commercialValues, commercial),
    label: 'commercial',
    values: commercialValues,
  };
  const internalIdentity = {
    ...deploymentIdentity('internal', internalValues, internal),
    label: 'internal',
    values: internalValues,
  };
  assertPhysicalIsolation(commercialIdentity, internalIdentity);
  assertG3Policies(commercialIdentity, internalIdentity);

  for (const line of [
    ...safeResourceSummary('commercial', commercial),
    `commercial_customer_commands=${commercialIdentity.customerCommands}`,
    ...safeResourceSummary('internal', internal),
    `internal_customer_commands=${internalIdentity.customerCommands}`,
    'G3_DEPLOYMENT_ISOLATION_OK=1',
  ]) console.log(line);
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown verifier failure';
  console.error(`G3_DEPLOYMENT_ISOLATION_ERROR=${message}`);
  process.exitCode = 1;
}
