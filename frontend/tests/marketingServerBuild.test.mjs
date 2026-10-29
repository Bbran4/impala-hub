import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

test('compiled Marketing handlers resolve their JavaScript dependencies and start', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const output = mkdtempSync(path.join(root, '.marketing-server-test-'))
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
      '--project', path.join(root, 'tsconfig.server-test.json'), '--outDir', output], { cwd: root, stdio: 'pipe' })
    const handlers = ['facebook/sync', 'facebook/publish', 'facebook/publish-due', 'posts']
    for (const name of handlers) {
      const entry = path.join(output, 'api/marketing', `${name}.js`)
      const { default: handler } = await import(pathToFileURL(entry).href)
      let code
      const response = { status(value) { code = value; return this }, json() { return this } }
      await handler({ method: 'DELETE', headers: {} }, response)
      assert.equal(code, 405, `${name} starts and rejects unsupported methods`)
    }
    assert.match(readFileSync(path.join(output, 'src/recordLists.js'), 'utf8'), /from ['"]\.\/pagedRows\.js['"]/)
  } finally { rmSync(output, { recursive: true, force: true }) }
})
