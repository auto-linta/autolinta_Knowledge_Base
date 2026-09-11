import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Exercise the real Pinia store, queue and hash code. Only auth and HTTP boundaries are replaced.
const src = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: `export { useKnowledgeUploadsStore } from './stores/knowledgeUploads'; export { createPinia, setActivePinia, disposePinia } from 'pinia'; export { auth } from './stores/auth';`, resolveDir: src },
  bundle: true, write: false, format: 'esm', platform: 'browser', alias: { '@': src },
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{ name: 'upload-test-boundaries', setup(builder) {
    builder.onLoad({ filter: /\/stores\/auth\.ts$/ }, () => ({ contents: `import { reactive } from 'vue'; export const auth = reactive({ isLoggedIn: true, user: { id: 'user' }, effectiveTenantId: 7 }); export const useAuthStore = () => auth;`, resolveDir: src }))
    builder.onLoad({ filter: /\/api\/knowledge-base\/index\.ts$/ }, () => ({ contents: ['uploadKnowledgeFile', 'preflightKnowledgeFiles', 'batchQueryKnowledge', 'batchDeleteKnowledge'].map(name => `export const ${name} = (...args) => globalThis.__uploadTestAPI.${name}(...args);`).join('\n') }))
  } }],
})
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`)
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5))
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick() }
  assert.fail('Upload store did not reach the expected state')
}
const selection = (name: string) => ({ kbId: 'kb', kbName: 'Repair', files: [{ file: new File([name], `${name}.pdf`), path: `k5/${name}.pdf` }] })

function setup(overrides: Record<string, (...args: any[]) => any> = {}) {
  const pinia = runtime.createPinia(); runtime.setActivePinia(pinia)
  runtime.auth.isLoggedIn = true; runtime.auth.effectiveTenantId = 7
  const target = globalThis as any
  target.window = new EventTarget()
  target.__uploadTestAPI = {
    preflightKnowledgeFiles: async (_kb: string, files: any[]) => ({ success: true, data: files.map(file => ({ id: file.id, duplicate: false })) }),
    uploadKnowledgeFile: async (_kb: string, data: any) => ({ success: true, data: { id: data.file.name, parse_status: 'pending' } }),
    batchQueryKnowledge: async (qs: string) => ({ success: true, data: new URLSearchParams(qs).getAll('ids').map(id => ({ id, parse_status: 'completed' })) }),
    batchDeleteKnowledge: async () => { throw new Error('Unexpected delete') },
    ...overrides,
  }
  return { store: runtime.useKnowledgeUploadsStore(), cleanup: () => runtime.disposePinia(pinia) }
}

test('global store serializes selections, snapshots tags/path/config, and observes parsing separately', async () => {
  let release!: () => void
  let firstStarted = false
  const received: any[] = []
  const { store, cleanup } = setup({ uploadKnowledgeFile: async (_kb, data, progress) => {
    received.push(data); progress({ loaded: 5, total: 10 })
    if (received.length === 1) { firstStarted = true; await new Promise<void>(resolve => { release = resolve }) }
    return { success: true, data: { id: data.file.name, parse_status: 'pending' } }
  } })
  try {
    const tags = ['vehicle-k5']; const config = { enable_question_generation: false }
    const first = store.start({ ...selection('first'), tagIds: tags, processConfig: config })
    await until(() => firstStarted)
    const second = store.start(selection('second'))
    tags.push('later'); config.enable_question_generation = true
    assert.equal(second.queued, true); assert.equal(received.length, 1)
    assert.equal(first.items[0].progress, 50)
    release(); await until(() => !store.busy)
    await store.refresh()
    assert.equal(store.visibleBatches.length, 2)
    assert.equal(received[0].fileName, 'k5/first.pdf')
    assert.deepEqual(received[0].tag_ids, ['vehicle-k5'])
    assert.equal(received[0].process_config.enable_question_generation, false)
    await until(() => first.items[0].parseStatus === 'completed')
    assert.equal(first.items[0].state, 'uploaded')
  } finally { cleanup() }
})

test('account/space changes abort transfers and prevent retry or delete from the old context', async () => {
  let received = 0, aborted = false
  const { store, cleanup } = setup({ uploadKnowledgeFile: async (_kb, _data, _progress, signal) => {
    received++
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true }))
  } })
  try {
    const old = store.start(selection('first'))
    await until(() => received === 1)
    store.start(selection('waiting'))
    runtime.auth.effectiveTenantId = 8
    assert.equal(aborted, true); assert.equal(store.visibleBatches.length, 0)
    store.retry(old); await store.rollback(old)
    await tick(); assert.equal(received, 1)
  } finally { cleanup() }
})

test('rollback never deletes duplicate matches and only reports removed after a status query proves absence', async () => {
  const deleted: string[][] = []
  let deleting = false
  const { store, cleanup } = setup({
    preflightKnowledgeFiles: async (_kb, files) => ({ success: true, data: files.map((file: any) => ({ id: file.id, duplicate: file.id === '1', knowledge_id: 'existing' })) }),
    batchQueryKnowledge: async (qs) => ({ success: true, data: deleting ? [] : new URLSearchParams(qs).getAll('ids').map(id => ({ id, parse_status: 'completed' })) }),
    batchDeleteKnowledge: async (_kb, ids) => { deleted.push(ids); deleting = true; return { success: true, data: { task_id: 'delete-task' } } },
  })
  try {
    const batch = store.start({ ...selection('new'), files: [...selection('new').files, ...selection('duplicate').files] })
    await until(() => !store.busy)
    assert.equal(batch.items[1].state, 'duplicate')
    await store.rollback(batch)
    assert.deepEqual(deleted, [['new.pdf']])
    assert.equal(batch.items[0].state, 'removed'); assert.equal(batch.items[1].state, 'duplicate')
  } finally { cleanup() }
})

test('stopping and retrying a queued selection does not execute its stale scheduled run', async () => {
  let release!: () => void
  const calls: string[] = []
  const { store, cleanup } = setup({ uploadKnowledgeFile: async (_kb, data) => {
    calls.push(data.file.name)
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve })
    return { success: true, data: { id: data.file.name, parse_status: 'completed' } }
  } })
  try {
    store.start(selection('first')); await until(() => calls.length === 1)
    const queued = store.start(selection('second'))
    store.stop(queued); store.retry(queued)
    release(); await until(() => !store.busy)
    assert.deepEqual(calls, ['first.pdf', 'second.pdf'])
  } finally { cleanup() }
})
