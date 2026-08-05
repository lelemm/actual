import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';

import { bootstrap, getAccountDb } from '#account-db';
import { config } from '#load-config';

import {
  hashPassword,
  loginWithPassword,
  setPasswordHash,
  verifyPassword,
} from './accounts/password.js';

const fixturePath = fileURLToPath(
  new URL('../contract/fixtures/password-hash-golden.json', import.meta.url),
);
const ownerId = 'password-golden-owner';
const originalTokenExpiration = config.get('token_expiration');
let originalAuth: Array<{
  method: string;
  display_name: string | null;
  extra_data: string | null;
  active: number;
}> = [];
let originalSessions: Array<{
  token: string;
  expires_at: number | null;
  user_id: string | null;
  auth_method: string | null;
}> = [];
let originalUsers: Array<{
  id: string;
  user_name: string | null;
  display_name: string | null;
  role: string | null;
  enabled: number;
  owner: number;
}> = [];

type VerificationCase = {
  id: string;
  password: string;
  hash: string;
  expected: boolean;
};

type Workflow = {
  password: string;
  storedHash: string;
  result: 'token' | 'invalid-password';
  hashAfter: 'argon2id-current' | 'unchanged';
  sessionCount: number;
  userCount: number;
  usersBefore: 'empty' | 'existing-owner';
  userAfter: 'created-blank-admin-owner' | 'existing-owner';
};
type BootstrapWorkflow = Omit<Workflow, 'storedHash'> & { userCount: number };

type GoldenFixture = {
  version: number;
  currentArgon2: {
    algorithm: string;
    version: number;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  verificationCases: VerificationCase[];
  workflows: Record<string, Workflow>;
  bootstrapEmptyUsers: BootstrapWorkflow;
  persistedSession: {
    userId: string;
    authMethod: string;
    expiresAt: number;
  };
  persistedAuth: {
    method: string;
    displayName: string;
    active: number;
  };
};

const expected = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture;

function tokenFrom(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('token' in result) ||
    typeof result.token !== 'string'
  ) {
    throw new Error('Expected a login token');
  }
  return result.token;
}

function currentArgon2Prefix(): string {
  const parameters = expected.currentArgon2;
  return `$${parameters.algorithm}$v=${parameters.version}$m=${parameters.memoryCost},t=${parameters.timeCost},p=${parameters.parallelism}$`;
}

function parseArgon2Parameters(hash: string): GoldenFixture['currentArgon2'] {
  const match =
    /^\$(argon2(?:id|i|d))\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (match === null) {
    throw new Error('Production hash has an unsupported PHC format');
  }
  return {
    algorithm: match[1],
    version: Number(match[2]),
    memoryCost: Number(match[3]),
    timeCost: Number(match[4]),
    parallelism: Number(match[5]),
  };
}

function argon2Type(
  algorithm: string,
): typeof argon2.argon2d | typeof argon2.argon2i | typeof argon2.argon2id {
  if (algorithm === 'argon2d') return argon2.argon2d;
  if (algorithm === 'argon2i') return argon2.argon2i;
  if (algorithm === 'argon2id') return argon2.argon2id;
  throw new Error(`Unsupported Argon2 algorithm: ${algorithm}`);
}

async function buildFixtureHashes(
  currentParameters: GoldenFixture['currentArgon2'],
) {
  const current = {
    type: argon2Type(currentParameters.algorithm),
    version: currentParameters.version,
    memoryCost: currentParameters.memoryCost,
    timeCost: currentParameters.timeCost,
    parallelism: currentParameters.parallelism,
  };
  return {
    argonAscii: await argon2.hash('correct horse battery staple', {
      ...current,
      salt: Buffer.from('actual-fixture-argon-ascii-v1'),
    }),
    argonUnicode: await argon2.hash('café 🔐 密碼', {
      ...current,
      salt: Buffer.from('actual-fixture-argon-unicode-v1'),
    }),
    argonAlternate: await argon2.hash('parameter fixture', {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      salt: Buffer.from('actual-fixture-argon-alternate'),
    }),
    bcryptAscii: await bcrypt.hash(
      'legacy horse',
      '$2b$10$abcdefghijklmnopqrstuu',
    ),
    bcryptUnicode: await bcrypt.hash(
      'café 🔐 密碼',
      '$2b$04$abcdefghijklmnopqrstuu',
    ),
  };
}

function resetPasswordState() {
  const db = getAccountDb();
  db.mutate('DELETE FROM sessions');
  db.mutate('DELETE FROM auth');
  db.mutate('DELETE FROM users');
}

function prepareUsers(usersBefore: Workflow['usersBefore']) {
  if (usersBefore === 'existing-owner') {
    getAccountDb().mutate(
      'INSERT INTO users (id, user_name, display_name, enabled, owner, role) VALUES (?, ?, ?, 1, 1, ?)',
      [ownerId, '', '', 'ADMIN'],
    );
  }
}

beforeAll(() => {
  const db = getAccountDb();
  originalAuth = db.all('SELECT * FROM auth') as typeof originalAuth;
  originalSessions = db.all(
    'SELECT * FROM sessions',
  ) as typeof originalSessions;
  originalUsers = db.all('SELECT * FROM users') as typeof originalUsers;
});

beforeEach(() => {
  resetPasswordState();
  config.set('token_expiration', 'never');
});

afterEach(() => {
  const db = getAccountDb();
  db.mutate('DELETE FROM sessions');
  db.mutate('DELETE FROM auth');
  db.mutate('DELETE FROM users');
});

afterAll(() => {
  const db = getAccountDb();
  resetPasswordState();
  for (const user of originalUsers) {
    db.mutate(
      'INSERT INTO users (id, user_name, display_name, role, enabled, owner) VALUES (?, ?, ?, ?, ?, ?)',
      [
        user.id,
        user.user_name,
        user.display_name,
        user.role,
        user.enabled,
        user.owner,
      ],
    );
  }
  for (const auth of originalAuth) {
    db.mutate(
      'INSERT INTO auth (method, display_name, extra_data, active) VALUES (?, ?, ?, ?)',
      [auth.method, auth.display_name, auth.extra_data, auth.active],
    );
  }
  for (const session of originalSessions) {
    db.mutate(
      'INSERT INTO sessions (token, expires_at, user_id, auth_method) VALUES (?, ?, ?, ?)',
      [session.token, session.expires_at, session.user_id, session.auth_method],
    );
  }
  config.set('token_expiration', originalTokenExpiration);
});

it('matches fixed hashes generated by the TypeScript dependencies', async () => {
  const productionHash = await hashPassword('production-parameter-probe');
  const productionParameters = parseArgon2Parameters(productionHash);
  const generated = await buildFixtureHashes(productionParameters);
  const actual = structuredClone(expected);
  actual.currentArgon2 = productionParameters;
  for (const item of actual.verificationCases) {
    if (item.id.startsWith('argon2-current-')) item.hash = generated.argonAscii;
    if (item.id === 'argon2-unicode-success') {
      item.hash = generated.argonUnicode;
    }
    if (item.id === 'argon2-alternate-parameters-success') {
      item.hash = generated.argonAlternate;
    }
    if (item.id.startsWith('bcrypt-cost-10-')) {
      item.hash = generated.bcryptAscii;
    }
    if (item.id === 'bcrypt-cost-04-unicode-success') {
      item.hash = generated.bcryptUnicode;
    }
  }
  actual.workflows.legacySuccess.storedHash = generated.bcryptAscii;
  actual.workflows.legacyFailure.storedHash = generated.bcryptAscii;
  actual.workflows.currentSuccess.storedHash = generated.argonAscii;
  actual.workflows.legacySuccessEmptyUsers.storedHash = generated.bcryptAscii;

  if (process.env.UPDATE_PASSWORD_GOLDEN === '1') {
    writeFileSync(fixturePath, `${JSON.stringify(actual, null, 2)}\n`);
  }
  expect(actual).toEqual(expected);
});

it('matches every verification outcome in the shared fixture', async () => {
  expect(expected.version).toBe(1);
  for (const item of expected.verificationCases) {
    expect(await verifyPassword(item.password, item.hash), item.id).toBe(
      item.expected,
    );
  }
});

it.each(Object.entries(expected.workflows))(
  'matches persisted login side effects for %s',
  async (_id, workflow) => {
    prepareUsers(workflow.usersBefore);
    setPasswordHash(workflow.storedHash);
    const result = await loginWithPassword(workflow.password);
    const db = getAccountDb();
    const stored = db.first(
      "SELECT method, display_name, extra_data, active FROM auth WHERE method = 'password'",
    ) as {
      method: string;
      display_name: string;
      extra_data: string;
      active: number;
    };
    const sessions = db.all(
      'SELECT token, expires_at, user_id, auth_method FROM sessions WHERE auth_method = ?',
      ['password'],
    ) as Array<{
      token: string;
      expires_at: number;
      user_id: string;
      auth_method: string;
    }>;
    const users = db.all(
      "SELECT id, user_name, display_name, enabled, owner, role FROM users WHERE user_name = ''",
    ) as Array<{
      id: string;
      user_name: string;
      display_name: string;
      enabled: number;
      owner: number;
      role: string;
    }>;

    if (workflow.result === 'token') {
      expect(result.error).toBeUndefined();
      expect(result.token).toBeTypeOf('string');
    } else {
      expect(result).toEqual({ error: workflow.result });
    }
    if (workflow.hashAfter === 'unchanged') {
      expect(stored.extra_data).toBe(workflow.storedHash);
    } else {
      expect(stored.extra_data.startsWith(currentArgon2Prefix())).toBe(true);
      expect(await verifyPassword(workflow.password, stored.extra_data)).toBe(
        true,
      );
    }
    expect({
      method: stored.method,
      displayName: stored.display_name,
      active: stored.active,
    }).toEqual(expected.persistedAuth);
    expect(sessions).toHaveLength(workflow.sessionCount);
    expect(users).toHaveLength(workflow.userCount);
    expect(users[0]).toEqual({
      id:
        workflow.userAfter === 'existing-owner'
          ? expected.persistedSession.userId
          : expect.any(String),
      user_name: '',
      display_name: '',
      enabled: 1,
      owner: 1,
      role: 'ADMIN',
    });
    if (sessions.length === 1) {
      expect(sessions[0]).toEqual({
        token: result.token,
        expires_at: expected.persistedSession.expiresAt,
        user_id: users[0]?.id,
        auth_method: expected.persistedSession.authMethod,
      });
    }
  },
);

it('bootstraps an empty users table with an owner and password session', async () => {
  const workflow = expected.bootstrapEmptyUsers;
  prepareUsers(workflow.usersBefore);

  const token = tokenFrom(await bootstrap({ password: workflow.password }));

  const db = getAccountDb();
  const user = db.first(
    "SELECT id, user_name, display_name, enabled, owner, role FROM users WHERE user_name = ''",
  ) as {
    id: string;
    user_name: string;
    display_name: string;
    enabled: number;
    owner: number;
    role: string;
  };
  const auth = db.first(
    "SELECT extra_data FROM auth WHERE method = 'password'",
  ) as { extra_data: string };
  const session = db.first(
    "SELECT token, expires_at, user_id, auth_method FROM sessions WHERE auth_method = 'password'",
  );
  const userCount = db.first(
    "SELECT count(*) count FROM users WHERE user_name = '' AND display_name = '' AND enabled = 1 AND owner = 1 AND role = 'ADMIN'",
  ) as { count: number };
  const sessionCount = db.first(
    "SELECT count(*) count FROM sessions WHERE auth_method = 'password'",
  ) as { count: number };
  expect(userCount.count).toBe(workflow.userCount);
  expect(sessionCount.count).toBe(workflow.sessionCount);
  expect(user).toEqual({
    id: expect.any(String),
    user_name: '',
    display_name: '',
    enabled: 1,
    owner: 1,
    role: 'ADMIN',
  });
  expect(auth.extra_data.startsWith(currentArgon2Prefix())).toBe(true);
  expect(await verifyPassword(workflow.password, auth.extra_data)).toBe(true);
  expect(session).toEqual({
    token,
    expires_at: expected.persistedSession.expiresAt,
    user_id: user.id,
    auth_method: expected.persistedSession.authMethod,
  });
});
