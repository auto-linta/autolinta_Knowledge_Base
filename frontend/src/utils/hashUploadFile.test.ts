import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { hashUploadFile } from './hashUploadFile.ts'

test('browser fingerprint matches server MD5 for empty, Unicode and multi-chunk binary files', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('起亚 K5 维修电路图'), Buffer.alloc(5 * 1024 * 1024 + 17, 0xab)]) {
    assert.equal(await hashUploadFile(new Blob([bytes]), new AbortController().signal), createHash('md5').update(bytes).digest('hex'))
  }
})
test('fingerprint checks cancellation between chunks', async () => {
  const controller = new AbortController()
  const hashing = hashUploadFile(new Blob([new Uint8Array(6 * 1024 * 1024)]), controller.signal)
  controller.abort()
  await assert.rejects(hashing, { name: 'AbortError' })
})
