import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = join(repoRoot, 'scripts/verify-g3-deployment-isolation.mjs');
const tempRoots: string[] = [];

const secret = (character: string) => character.repeat(64);

interface DeploymentFixture {
  project: string;
  databaseUser: string;
  databasePassword: string;
  databaseName: string;
  backupDirectory: string;
  backupSecret: string;
  jwtSecret: string;
  aiSecret: string;
  edition: 'commercial' | 'internal';
  entitlements: string;
  customerCommands: '0' | '1';
  methodologyCommands: '0' | '1';
  port: string;
}

const commercialFixture = (): DeploymentFixture => ({
  project: 'jianghu-commercial-g3-test',
  databaseUser: 'jianghu_commercial_test',
  databasePassword: secret('1'),
  databaseName: 'jianghu_commercial_test',
  backupDirectory: '/var/backups/jianghu-commercial-g3-test',
  backupSecret: secret('2'),
  jwtSecret: secret('3'),
  aiSecret: secret('4'),
  edition: 'commercial',
  entitlements: '',
  customerCommands: '1',
  methodologyCommands: '0',
  port: '18080',
});

const internalFixture = (): DeploymentFixture => ({
  project: 'jianghu-internal-g3-test',
  databaseUser: 'jianghu_internal_test',
  databasePassword: secret('5'),
  databaseName: 'jianghu_internal_test',
  backupDirectory: '/var/backups/jianghu-internal-g3-test',
  backupSecret: secret('6'),
  jwtSecret: secret('7'),
  aiSecret: secret('8'),
  edition: 'internal',
  entitlements: '',
  customerCommands: '1',
  methodologyCommands: '0',
  port: '18081',
});

function writeDeployment(
  root: string,
  name: string,
  fixture: DeploymentFixture,
  omittedKeys = new Set<string>(),
): string {
  const path = join(root, `${name}.env`);
  const lines = [
    `COMPOSE_PROJECT_NAME=${fixture.project}`,
    `POSTGRES_USER=${fixture.databaseUser}`,
    `POSTGRES_PASSWORD=${fixture.databasePassword}`,
    `POSTGRES_DB=${fixture.databaseName}`,
    `BACKUP_DIR=${fixture.backupDirectory}`,
    'BACKUP_RETENTION_DAYS=14',
    `BACKUP_MASTER_SECRET=${fixture.backupSecret}`,
    `JWT_SECRET=${fixture.jwtSecret}`,
    `AI_KEY_SECRET=${fixture.aiSecret}`,
    'OUTBOUND_ALLOWED_HOSTS=example.com',
    `CUSTOMER_COMMANDS_ENABLED=${fixture.customerCommands}`,
    'COMMITMENT_COMMANDS_ENABLED=1',
    `METHODOLOGY_COMMANDS_ENABLED=${fixture.methodologyCommands}`,
    `PRODUCT_EDITION=${fixture.edition}`,
    `PRODUCT_ENTITLEMENTS=${fixture.entitlements}`,
    'CORS_ORIGIN=',
    'VITE_API_URL=',
    'VITE_BEIAN_MODE=',
    `WEB_PORT=${fixture.port}`,
    '',
  ];
  writeFileSync(path, lines.filter((line) => {
    const separator = line.indexOf('=');
    return separator < 0 || !omittedKeys.has(line.slice(0, separator));
  }).join('\n'));
  return path;
}

function runVerifier(
  commercial: DeploymentFixture,
  internal: DeploymentFixture,
  options: { omitCommercialKeys?: string[]; ambient?: Record<string, string> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'jianghu-g3-isolation-'));
  tempRoots.push(root);
  const commercialEnv = writeDeployment(
    root,
    'commercial',
    commercial,
    new Set(options.omitCommercialKeys ?? []),
  );
  const internalEnv = writeDeployment(root, 'internal', internal);
  return spawnSync(process.execPath, [
    verifier,
    '--commercial-env', commercialEnv,
    '--internal-env', internalEnv,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.ambient },
  });
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('SAAS-106 G3 deployment isolation verifier', () => {
  it('renders isolated commercial Free and internal Compose resources without echoing secrets', () => {
    const commercial = commercialFixture();
    const internal = internalFixture();

    const result = runVerifier(commercial, internal);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(result.stdout).toContain('G3_DEPLOYMENT_ISOLATION_OK=1');
    expect(result.stdout).toContain('commercial_project=jianghu-commercial-g3-test');
    expect(result.stdout).toContain('internal_project=jianghu-internal-g3-test');
    expect(result.stdout).toContain('commercial_customer_commands=1');
    for (const value of [
      commercial.databasePassword,
      commercial.backupSecret,
      commercial.jwtSecret,
      commercial.aiSecret,
      internal.databasePassword,
      internal.backupSecret,
      internal.jwtSecret,
      internal.aiSecret,
    ]) {
      expect(output).not.toContain(value);
    }
  });

  it('renders and reports the explicit commercial Customer command rollback state', () => {
    const result = runVerifier(
      { ...commercialFixture(), customerCommands: '0' },
      internalFixture(),
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(result.stdout).toContain('commercial_customer_commands=0');
  });

  it('fails closed when CUSTOMER_COMMANDS_ENABLED is absent from the deployment env file', () => {
    const result = runVerifier(commercialFixture(), internalFixture(), {
      omitCommercialKeys: ['CUSTOMER_COMMANDS_ENABLED'],
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(result.stderr).toContain('G3_DEPLOYMENT_ISOLATION_ERROR=');
  });

  it('fails closed when a required env-file secret exists only in the ambient process', () => {
    const commercial = commercialFixture();
    const internal = internalFixture();

    const result = runVerifier(commercial, internal, {
      omitCommercialKeys: ['POSTGRES_PASSWORD'],
      ambient: { POSTGRES_PASSWORD: commercial.databasePassword },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(result.stderr).toContain('G3_DEPLOYMENT_ISOLATION_ERROR=');
    expect(output).not.toContain(commercial.databasePassword);
  });

  it.each([
    ['Compose project', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial, project: internal.project,
    })],
    ['database identity', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial,
      databaseUser: internal.databaseUser,
      databaseName: internal.databaseName,
    })],
    ['database password', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial, databasePassword: internal.databasePassword,
    })],
    ['backup directory', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial, backupDirectory: internal.backupDirectory,
    })],
    ['backup master secret', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial, backupSecret: internal.backupSecret,
    })],
    ['JWT secret', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial, jwtSecret: internal.jwtSecret,
    })],
    ['AI key secret', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial, aiSecret: internal.aiSecret,
    })],
    ['published port', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      ...commercial, port: internal.port,
    })],
  ] as const)('fails closed when deployments reuse %s', (_label, collide) => {
    const internal = internalFixture();
    const commercial = collide(commercialFixture(), internal);

    const result = runVerifier(commercial, internal);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(result.stderr).toContain('G3_DEPLOYMENT_ISOLATION_ERROR=');
    for (const value of [
      commercial.databasePassword,
      commercial.backupSecret,
      commercial.jwtSecret,
      commercial.aiSecret,
      internal.databasePassword,
      internal.backupSecret,
      internal.jwtSecret,
      internal.aiSecret,
    ]) {
      expect(output).not.toContain(value);
    }
  });

  it.each([
    ['commercial edition', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      commercial: { ...commercial, edition: 'internal' as const }, internal,
    })],
    ['internal edition', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      commercial, internal: { ...internal, edition: 'commercial' as const },
    })],
    ['commercial Free entitlements', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      commercial: { ...commercial, entitlements: 'methodology.g64111' }, internal,
    })],
    ['commercial methodology command gate', (commercial: DeploymentFixture, internal: DeploymentFixture) => ({
      commercial: { ...commercial, methodologyCommands: '1' as const }, internal,
    })],
  ] as const)('fails closed for an invalid %s policy', (_label, mutate) => {
    const fixtures = mutate(commercialFixture(), internalFixture());

    const result = runVerifier(fixtures.commercial, fixtures.internal);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(result.stderr).toContain('G3_DEPLOYMENT_ISOLATION_ERROR=');
    for (const value of [
      fixtures.commercial.databasePassword,
      fixtures.commercial.backupSecret,
      fixtures.commercial.jwtSecret,
      fixtures.commercial.aiSecret,
      fixtures.internal.databasePassword,
      fixtures.internal.backupSecret,
      fixtures.internal.jwtSecret,
      fixtures.internal.aiSecret,
    ]) {
      expect(output).not.toContain(value);
    }
  });
});
