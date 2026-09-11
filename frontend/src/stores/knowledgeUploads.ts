import { computed, markRaw, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { uploadKnowledgeFile, preflightKnowledgeFiles, batchQueryKnowledge, batchDeleteKnowledge } from '@/api/knowledge-base'
import type { KnowledgeProcessOverrides } from '@/types/knowledgeProcess'
import { KnowledgeUploadQueue, errorMessage, rollbackIDs, type UploadBatch } from '@/utils/knowledgeUploadQueue'
import { hashUploadFile } from '@/utils/hashUploadFile'
import { waitForKnowledgeDeletion } from '@/utils/knowledgeDeletion'

export const useKnowledgeUploadsStore = defineStore('knowledgeUploads', () => {
  const auth = useAuthStore()
  const scope = computed(() => auth.isLoggedIn ? `${auth.user?.id}:${auth.effectiveTenantId}` : '')
  const batches = ref<UploadBatch[]>([])
  const visibleBatches = computed(() => batches.value.filter(batch => scope.value && batch.scope === scope.value))
  const busy = computed(() => batches.value.some(batch => batch.running || batch.queued || batch.revoking))
  const engines = new Map<string, KnowledgeUploadQueue>()
  const generations = new WeakMap<UploadBatch, number>()
  let tail: Promise<void> = Promise.resolve()
  let observation = new AbortController()
  let refreshing = false
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const current = (batch: UploadBatch) => !!scope.value && batch.scope === scope.value && batches.value.includes(batch)

  // One event per KB per half second; hundreds of uploads must not trigger hundreds of list requests.
  function notify(kbId: string) {
    if (refreshTimers.has(kbId)) return
    const expectedScope = scope.value
    refreshTimers.set(kbId, setTimeout(() => {
      refreshTimers.delete(kbId)
      if (scope.value === expectedScope) window.dispatchEvent(new CustomEvent('knowledgeFileUploaded', { detail: { kbId } }))
    }, 500))
  }

  watch(scope, () => {
    for (const batch of batches.value) if (batch.running || batch.queued) stop(batch)
    observation.abort()
    observation = new AbortController()
    // Do not reveal another account's filenames. The queue's in-flight callbacks may still settle.
    batches.value = []
    engines.clear()
  }, { flush: 'sync' })

  function schedule(batch: UploadBatch) {
    if (!current(batch) || batch.running || batch.queued || batch.revoking) return
    batch.stopped = false
    batch.queued = true
    batch.notice = undefined
    const engine = engines.get(batch.id)!
    const generation = (generations.get(batch) || 0) + 1
    generations.set(batch, generation)
    // Serialize batches, with up to three transfers within a batch. A second selection rechecks the first batch's receipts.
    tail = tail.then(async () => {
      if (generations.get(batch) !== generation) return
      batch.queued = false
      if (!current(batch) || batch.stopped) return
      await engine.run()
      if (current(batch)) { notify(batch.kbId); void refresh() }
    }).catch(error => { batch.queued = false; batch.error = errorMessage(error) })
  }

  function start(input: {
    kbId: string; kbName: string; files: { file: File; path: string }[]
    tagIds?: string[]; processConfig?: KnowledgeProcessOverrides
  }) {
    if (!scope.value || !input.files.length) return
    const id = crypto.randomUUID()
    batches.value.push({ id, kbId: input.kbId, kbName: input.kbName, scope: scope.value,
      items: input.files.map(({ file, path }, index) => ({ id: String(index), file: markRaw(file), path, state: 'waiting', progress: 0 })),
      running: false, checking: false, revoking: false, stopped: false })
    const batch = batches.value[batches.value.length - 1]!
    const tagIds = input.tagIds ? [...input.tagIds] : undefined
    const processConfig = input.processConfig ? JSON.parse(JSON.stringify(input.processConfig)) : undefined
    engines.set(id, new KnowledgeUploadQueue(batch, {
      hash: hashUploadFile,
      preflight: async (files, signal) => {
        if (!current(batch)) throw new DOMException('Context changed', 'AbortError')
        const response = await preflightKnowledgeFiles(batch.kbId, files, signal)
        if (response.success !== true || !Array.isArray(response.data)) throw new Error(response.message || 'Invalid preflight response')
        return response.data
      },
      upload: async (item, signal, progress) => {
        if (!current(batch)) throw new DOMException('Context changed', 'AbortError')
        const response = await uploadKnowledgeFile(batch.kbId, {
          file: item.file, fileName: item.path, tag_ids: tagIds, process_config: processConfig,
        }, event => { if (event.total) progress(event.loaded / event.total * 100) }, signal)
        if (response.success !== true || !response.data?.id) throw response
        return response.data
      },
      accepted: () => { if (current(batch)) notify(batch.kbId) },
    }))
    schedule(batch)
    return batch
  }

  function stop(batch: UploadBatch) {
    generations.set(batch, (generations.get(batch) || 0) + 1)
    engines.get(batch.id)?.stop()
    batch.queued = false
  }

  function dismiss(batch: UploadBatch) {
    if (batch.running || batch.queued || batch.revoking) return
    batches.value = batches.value.filter(value => value.id !== batch.id)
    engines.delete(batch.id)
  }

  async function fetchRows(batch: UploadBatch, ids: string[], signal: AbortSignal) {
    signal.throwIfAborted()
    if (!current(batch)) throw new DOMException('Context changed', 'AbortError')
    const qs = new URLSearchParams()
    ids.forEach(id => qs.append('ids', id))
    const response = await batchQueryKnowledge(qs.toString(), batch.kbId, undefined, undefined, signal)
    if (response.success !== true || (response.data !== null && !Array.isArray(response.data))) throw new Error('Invalid document status response')
    if (response.data?.some((row: any) => !ids.includes(row.id))) throw new Error('Unexpected document in status response')
    return response
  }

  async function refresh() {
    if (refreshing) return
    refreshing = true
    const signal = observation.signal
    try {
      for (const batch of visibleBatches.value) {
        if (batch.revoking) continue
        const pending = batch.items.filter(item => item.state === 'uploaded' && !['completed', 'failed', 'cancelled', 'missing'].includes(item.parseStatus || ''))
        if (!pending.length) continue
        for (let offset = 0; offset < pending.length; offset += 50) {
          const items = pending.slice(offset, offset + 50)
          const response = await fetchRows(batch, items.map(item => item.knowledgeId!), signal)
          if (signal.aborted || !current(batch)) return
          const rows = new Map<string, any>((response.data || []).map((row: any) => [row.id, row]))
          for (const item of items) {
            const row = rows.get(item.knowledgeId!)
            item.parseStatus = row?.parse_status || 'missing'
            item.parseError = row?.error_message || undefined
          }
        }
        batch.notice = undefined
      }
    } catch (error) {
      if (!signal.aborted) for (const batch of visibleBatches.value) {
        batch.notice = 'statusUnavailable'
      }
    } finally { refreshing = false }
  }

  async function rollback(batch: UploadBatch) {
    if (!current(batch) || batch.running || batch.queued || batch.revoking) return
    const ids = rollbackIDs(batch)
    if (!ids.length) return
    batch.revoking = true; batch.error = undefined; batch.notice = undefined
    const signal = observation.signal
    const active = () => !signal.aborted && current(batch)
    const fetch = async (part: string[]) => {
      const response = await fetchRows(batch, part, signal)
      if (!active()) return response
      const remaining = new Set((response.data || []).map((row: any) => row.id))
      for (const item of batch.items) if (item.knowledgeId && part.includes(item.knowledgeId) && !remaining.has(item.knowledgeId)) item.state = 'removed'
      return response
    }
    try {
      // Reconcile first: a previous asynchronous delete may have completed after a timeout.
      for (let offset = 0; offset < ids.length; offset += 50) {
        const response = await fetch(ids.slice(offset, offset + 50))
        if (!active()) return
        const existing = (response.data || []).filter((row: any) => row.parse_status !== 'deleting').map((row: any) => row.id)
        if (existing.length) {
          const result = await batchDeleteKnowledge(batch.kbId, existing, signal)
          if (result.success !== true || !result.data?.task_id) throw new Error(result.message || 'Delete was not accepted')
        }
        if (!active()) return
        for (const item of batch.items) if (item.knowledgeId && ids.slice(offset, offset + 50).includes(item.knowledgeId) && item.state !== 'removed') item.state = 'deleting'
      }
      const result = await waitForKnowledgeDeletion(ids, fetch, { isActive: active })
      if (active() && result !== 'completed') batch.notice = result === 'failed' ? 'rollbackFailed' : 'rollbackPending'
    } catch (error) {
      if (active()) { batch.error = errorMessage(error); batch.notice = 'rollbackPending' }
    } finally {
      // Keep receipts until absence is verified; another click safely reconciles remaining IDs.
      for (const item of batch.items) if (item.state === 'deleting') item.state = 'uploaded'
      batch.revoking = false
      if (active()) notify(batch.kbId)
    }
  }

  return { visibleBatches, busy, start, stop, retry: schedule, dismiss, refresh, rollback }
})
