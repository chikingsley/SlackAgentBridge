import { test } from 'vitest'
import assert from 'node:assert/strict'
// Legacy JavaScript provider boundary; the direct adapter itself is TypeScript.
const { PROVIDERS, normalizeProvider, providerOf, providerCommand, resumeArgsFor, parseSlackCommand } =
  await import(new URL('../../daemon/providers.mjs', import.meta.url).href)

test('only Claude and Codex are supported; removed providers cannot become Claude', () => {
  assert.deepEqual(PROVIDERS, ['claude', 'codex'])
  assert.equal(normalizeProvider('pi'), null)
  assert.equal(providerOf({ provider: 'pi' }), null)
  assert.throws(() => providerCommand('pi'), /Unsupported provider/)
  assert.throws(() => resumeArgsFor({ provider: 'pi', id: 'old-pi' }), /Unsupported provider/)
  assert.equal(providerOf({}), 'claude')
  assert.equal(parseSlackCommand('/pi-new'), null)
})
