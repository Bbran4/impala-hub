import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Execute the actual HTTP handlers with isolated database/publisher adapters.
// Shared authentication and the real atomic publisher have separate tests.
const bundled = await build({
  stdin: {
    contents: `export {default as publish} from './api/marketing/facebook/publish.ts'; export {default as pages} from './api/marketing/facebook/pages.ts'`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  plugins: [{
    name: 'isolated-api-adapters',
    setup(builder) {
      builder.onResolve({ filter: /_lib\/auth\.ts$/ }, () => ({ path: 'auth', namespace: 'adapter' }));
      builder.onResolve({ filter: /_publishing\.js$/ }, () => ({ path: 'publisher', namespace: 'adapter' }));
      builder.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({ contents: path === 'auth'
        ? `export async function requireMarketingSession(req,access){globalThis.__impalaApiFixture.access.push(access);return globalThis.__impalaApiFixture.context}`
        : `export async function claimPost(...args){return globalThis.__impalaApiFixture.claim(...args)};export async function publishClaimed(...args){return globalThis.__impalaApiFixture.publish(...args)}`,
      }));
    },
  }],
});
const handlers = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
after(() => { delete globalThis.__impalaApiFixture; });

function fixture({ owner = 'employee', connection = true, claim = true, status = 'published' } = {}) {
  const queries = [], claims = [], publishes = [], access = [];
  const rows = {
    posts: { id: 'post', created_by: owner },
    provider_connections: connection ? { provider: 'facebook', is_workspace_connection: true, page_id: 'page', token_ciphertext: 'encrypted' } : null,
    oauth_page_choices: { owner_id: 'employee', expires_at: '2999-01-01T00:00:00.000Z', pages: [{ id: 'page', name: 'Page', access_token: 'must-never-leak', tasks: ['CREATE_CONTENT'] }] },
  };
  const admin = { from(table) {
    const filters = [];
    const q = {
      select() { return q; },
      eq(key, value) { filters.push((row) => row[key] === value); queries.push([table, 'eq', key, value]); return q; },
      gt(key, value) { filters.push((row) => row[key] > value); queries.push([table, 'gt', key, value]); return q; },
      async maybeSingle() { const row = rows[table]; return { data: row && filters.every((filter) => filter(row)) ? row : null, error: null }; },
    };
    return q;
  } };
  const f = {
    context: { admin, user: { id: 'employee' }, settings: { encryptionKey: 'key' } }, rows, queries, claims, publishes, access,
    async claim(...args) { claims.push(args); return claim ? { id: 'post', status: 'publishing' } : null; },
    async publish(...args) { publishes.push(args); return { id: 'post', status }; },
  };
  globalThis.__impalaApiFixture = f;
  return f;
}
async function invoke(handler, method = 'POST') {
  const result = {};
  const response = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
  await handler({ method, headers: {}, query: { post_id: 'post' } }, response);
  return result;
}

test('publish HTTP handler enforces ownership and requires a live connection before claiming', async () => {
  const other = fixture({ owner: 'another-user' });
  assert.equal((await invoke(handlers.publish)).status, 404);
  assert.equal(other.claims.length, 0);
  assert.deepEqual(other.queries.find((q) => q[2] === 'created_by'), ['posts', 'eq', 'created_by', 'employee']);
  const disconnected = fixture({ connection: false });
  assert.equal((await invoke(handlers.publish)).status, 409);
  assert.equal(disconnected.claims.length, 0);
});
test('publish HTTP handler never publishes when the atomic claim loses a race', async () => {
  const f = fixture({ claim: false });
  assert.equal((await invoke(handlers.publish)).status, 409);
  assert.equal(f.publishes.length, 0);
  assert.equal(f.claims[0][3], 'employee');
  assert.deepEqual(f.access, ['publishing']);
});
test('publish HTTP responses preserve confirmed, unknown and failed outcomes', async () => {
  for (const status of ['published', 'publish_unknown', 'failed']) {
    const f = fixture({ status });
    const result = await invoke(handlers.publish);
    assert.equal(result.status, status === 'published' ? 200 : 502);
    assert.equal(result.body.status, status);
    assert.equal(f.publishes.length, 1);
  }
  const f = fixture();
  f.publish = async () => { throw new Error('private provider token must-never-leak'); };
  const result = await invoke(handlers.publish);
  assert.equal(result.status, 500);
  assert.match(result.body.detail, /Do not retry/);
  assert.doesNotMatch(JSON.stringify(result.body), /must-never-leak/);
});
test('Pages HTTP handler limits choices to the caller, checks expiry and removes access tokens', async () => {
  const f = fixture();
  const result = await invoke(handlers.pages, 'GET');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.pages, [{ id: 'page', name: 'Page', tasks: ['CREATE_CONTENT'] }]);
  assert.doesNotMatch(JSON.stringify(result.body), /must-never-leak|access_token/);
  assert.ok(f.queries.some((q) => q[2] === 'owner_id' && q[3] === 'employee'));
  assert.ok(f.queries.some((q) => q[1] === 'gt' && q[2] === 'expires_at'));
  f.rows.oauth_page_choices.expires_at = '2000-01-01T00:00:00.000Z';
  assert.deepEqual((await invoke(handlers.pages, 'GET')).body.pages, []);
});
