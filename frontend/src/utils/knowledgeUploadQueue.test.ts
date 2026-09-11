import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeUploadQueue, rollbackIDs, uploadCounts, type UploadBatch, type QueueDependencies } from './knowledgeUploadQueue.ts'

const makeBatch = (count: number): UploadBatch => ({
  id: 'batch', kbId: 'kb', kbName: 'Repair', scope: 'user:7', running: false, checking: false, stopped: false, revoking: false,
  items: Array.from({ length: count }, (_, i) => ({ id: String(i), file: new File([String(i)], `${i}.pdf`), path: `k5/${i}.pdf`, state: 'waiting', progress: 0 })),
})
const deps = (overrides: Partial<QueueDependencies> = {}): QueueDependencies => ({
  hash: async file => file.text(),
  preflight: async files => files.map(file => ({ id: file.id, duplicate: false })),
  upload: async item => ({ id: `new-${item.id}` }), ...overrides,
})
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test('446 files are preflighted in bounded batches then uploaded with at most three transfers', async () => {
  const batch = makeBatch(446)
  const chunks: number[] = []
  let active = 0, maximum = 0, bodies = 0
  const engine = new KnowledgeUploadQueue(batch, deps({
    preflight: async files => { chunks.push(files.length); assert.equal(bodies, 0); return files.map(file => ({ id: file.id, duplicate: false })) },
    upload: async (item, _signal, progress) => {
      assert.deepEqual(chunks, [200, 200, 46]); bodies++; active++; maximum = Math.max(maximum, active)
      progress(55); assert.equal(item.progress, 55)
      await tick(); active--
      return { id: `new-${item.id}`, parse_status: 'pending' }
    },
  }))
  await engine.run()
  assert.equal(maximum, 3); assert.equal(bodies, 446)
  assert.equal(uploadCounts(batch).uploaded, 446)
  assert.equal(batch.running, false)
  assert.ok(batch.items.every(item => item.parseStatus === 'pending'))
})

test('renamed duplicate content is rejected; same name with different content remains eligible', async () => {
  const batch = makeBatch(4)
  batch.items[1]!.file = new File(['0'], 'renamed.pdf')
  batch.items[2]!.file = new File(['2'], '0.pdf')
  let bodyIDs: string[] = []
  await new KnowledgeUploadQueue(batch, deps({
    preflight: async files => {
      assert.deepEqual(files.map(file => file.id), ['0', '2', '3'])
      return files.map(file => ({ id: file.id, duplicate: file.id === '3', knowledge_id: 'existing', file_name: 'old.pdf' }))
    },
    upload: async item => { bodyIDs.push(item.id); return { id: `new-${item.id}` } },
  })).run()
  assert.deepEqual(bodyIDs.sort(), ['0', '2'])
  assert.equal(batch.items[1]!.reason, 'batchDuplicate')
  assert.equal(batch.items[3]!.reason, 'serverDuplicate')
  assert.deepEqual(rollbackIDs(batch), ['new-0', 'new-2'])
})

test('last preflight chunk failure prevents all bodies; malformed results are not accepted', async () => {
  for (const malformed of [false, true]) {
    const batch = makeBatch(201)
    let calls = 0, bodies = 0
    await new KnowledgeUploadQueue(batch, deps({
      preflight: async files => {
        if (++calls === 2) { if (malformed) return []; throw new Error('offline') }
        return files.map(file => ({ id: file.id, duplicate: false }))
      },
      upload: async () => { bodies++; return { id: 'unexpected' } },
    })).run()
    assert.equal(bodies, 0); assert.equal(uploadCounts(batch).failed, 201)
    assert.ok(batch.items.every(item => item.reason === 'preflightFailed'))
  }
  const batch = makeBatch(1)
  await new KnowledgeUploadQueue(batch, deps({
    preflight: async () => [{ id: '0' } as any],
    upload: async () => { assert.fail('A missing duplicate verdict must not allow upload') },
  })).run()
  assert.equal(batch.items[0]!.state, 'failed')
  assert.equal(batch.items[0]!.reason, 'preflightFailed')
})

test('stop aborts three transfers, keeps known receipts, and retry reconciles uncertain requests first', async () => {
  const batch = makeBatch(8)
  let started = 0, attempt = 0
  const stored = new Set<string>()
  let startedThree!: () => void
  const ready = new Promise<void>(resolve => { startedThree = resolve })
  const engine = new KnowledgeUploadQueue(batch, deps({
    preflight: async files => files.map(file => ({ id: file.id, duplicate: stored.has(file.id), knowledge_id: `existing-${file.id}` })),
    upload: async (item, signal) => {
      if (attempt) { assert.ok(!stored.has(item.id)); return { id: `new-${item.id}` } }
      stored.add(item.id)
      if (++started === 3) startedThree()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    },
  }))
  const run = engine.run(); await ready; engine.stop(); await run
  assert.equal(started, 3)
  assert.equal(batch.items.filter(item => item.state === 'uncertain').length, 3)
  assert.equal(uploadCounts(batch).cancelled, 5)
  assert.deepEqual(rollbackIDs(batch), [])
  attempt++
  await engine.run()
  assert.equal(uploadCounts(batch).duplicate, 3)
  assert.equal(uploadCounts(batch).uploaded, 5)
  assert.deepEqual(rollbackIDs(batch), ['new-3', 'new-4', 'new-5', 'new-6', 'new-7'])
})

test('server 409 never becomes a rollback target; ordinary failures are visible and do not hide remaining uploads', async () => {
  const batch = makeBatch(5)
  await new KnowledgeUploadQueue(batch, deps({
    upload: async item => {
      if (item.id === '0') throw { status: 409, code: 'duplicate_file', data: { id: 'existing' } }
      if (item.id === '1') throw { status: 413, message: 'File too large' }
      return { id: `new-${item.id}` }
    },
  })).run()
  assert.equal(uploadCounts(batch).uploaded, 3)
  assert.equal(uploadCounts(batch).duplicate, 1)
  assert.equal(batch.items[1]!.error, 'File too large')
  assert.ok(!rollbackIDs(batch).includes('existing'))
})

test('permission loss or repeated connection failures stop dispatch; an empty success response is uncertain', async () => {
  for (const error of [{ status: 403, message: 'Forbidden' }, new Error('offline')]) {
    const batch = makeBatch(30)
    let bodies = 0
    await new KnowledgeUploadQueue(batch, deps({ upload: async () => { bodies++; throw error } })).run()
    // Three failures can occur while two other workers have already dispatched their next request.
    assert.ok(bodies <= ('status' in error ? 3 : 5))
    assert.ok(uploadCounts(batch).cancelled >= 25)
    assert.ok(batch.error)
  }
  const batch = makeBatch(1)
  await new KnowledgeUploadQueue(batch, deps({ upload: async () => ({} as { id: string }) })).run()
  assert.equal(batch.items[0]!.state, 'uncertain')
  assert.equal(uploadCounts(batch).uploaded, 0)
})

test('stop while hashing sends no preflight or upload; retry skips already accepted and removed files', async () => {
  const batch = makeBatch(3)
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const engine = new KnowledgeUploadQueue(batch, deps({
    hash: async () => { started(); await new Promise<void>(resolve => { release = resolve }); return 'hash' },
    preflight: async () => { throw new Error('must not preflight') },
  }))
  const run = engine.run(); await ready; engine.stop(); release(); await run
  assert.equal(uploadCounts(batch).cancelled, 3)
  batch.items[0]!.state = 'uploaded'; batch.items[0]!.knowledgeId = 'accepted'
  batch.items[1]!.state = 'removed'; batch.items[1]!.knowledgeId = 'deleted'
  const uploads: string[] = []
  await new KnowledgeUploadQueue(batch, deps({ upload: async item => { uploads.push(item.id); return { id: 'new' } } })).run()
  assert.deepEqual(uploads, ['2'])
  assert.deepEqual(rollbackIDs(batch), ['accepted', 'new'])
})
