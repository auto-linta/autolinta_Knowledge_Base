export type UploadState = 'waiting' | 'checking' | 'uploading' | 'uploaded' | 'duplicate' | 'failed' | 'cancelled' | 'uncertain' | 'deleting' | 'removed'
export interface UploadItem {
  id: string
  file: File
  path: string
  hash?: string
  state: UploadState
  progress: number
  reason?: string
  error?: string
  duplicateName?: string
  knowledgeId?: string
  parseStatus?: string
  parseError?: string
}
export interface UploadBatch {
  id: string
  kbId: string
  kbName: string
  scope: string
  items: UploadItem[]
  running: boolean
  checking: boolean
  revoking: boolean
  stopped: boolean
  queued?: boolean
  notice?: string
  error?: string
}
export interface Fingerprint { id: string; file_hash: string; file_type: string }
export interface PreflightMatch { id: string; duplicate: boolean; file_name?: string; folder_path?: string; knowledge_id?: string }
export interface QueueDependencies {
  hash(file: File, signal: AbortSignal): Promise<string>
  preflight(files: Fingerprint[], signal: AbortSignal): Promise<PreflightMatch[]>
  upload(item: UploadItem, signal: AbortSignal, progress: (percent: number) => void): Promise<{ id: string; parse_status?: string }>
  accepted?(item: UploadItem): void
}

export function errorMessage(error: any): string {
  return error?.error?.message || error?.message || String(error)
}
export function duplicateError(error: any): boolean {
  return (error?.code || error?.error?.code) === 'duplicate_file'
}
const fileType = (file: File) => file.name.split('.').pop()!.toLowerCase()
const contentKey = (item: UploadItem) => `${fileType(item.file)}:${item.hash}`
const pending = (item: UploadItem) => ['waiting', 'checking'].includes(item.state)

/** HTTP success only means received. Parsing is observed separately by the store. */
export class KnowledgeUploadQueue {
  private controller = new AbortController()
  constructor(readonly batch: UploadBatch, private deps: QueueDependencies) {}

  stop() {
    this.batch.stopped = true
    this.controller.abort()
    for (const item of this.batch.items) {
      if (pending(item)) item.state = 'cancelled'
    }
  }

  async run() {
    if (this.batch.running || this.batch.revoking) return
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.batch.running = true
    this.batch.stopped = false
    this.batch.error = undefined
    // Retrying always rechecks server state, including requests with lost responses.
    const items = this.batch.items.filter(item => !['uploaded', 'removed'].includes(item.state))
    for (const item of items) {
      item.state = 'waiting'; item.progress = 0; item.reason = undefined
      item.error = undefined; item.duplicateName = undefined
    }
    try {
      this.batch.checking = true
      const seen = new Map<string, UploadItem>()
      for (const item of this.batch.items.filter(item => item.state === 'uploaded')) seen.set(contentKey(item), item)
      const candidates: UploadItem[] = []
      for (const item of items) {
        if (signal.aborted) return
        item.state = 'checking'
        item.hash ||= await this.deps.hash(item.file, signal)
        if (signal.aborted) return
        const previous = seen.get(contentKey(item))
        if (previous) {
          item.state = 'duplicate'; item.reason = 'batchDuplicate'; item.duplicateName = previous.path
        } else {
          seen.set(contentKey(item), item)
          candidates.push(item)
        }
      }
      // Complete all preflights before uploading any bodies; a failed check is never bypassed.
      for (let offset = 0; offset < candidates.length; offset += 200) {
        if (signal.aborted) return
        const chunk = candidates.slice(offset, offset + 200)
        const matches = await this.deps.preflight(chunk.map(item => ({ id: item.id, file_hash: item.hash!, file_type: fileType(item.file) })), signal)
        if (signal.aborted) return
        const map = new Map(matches.map(match => [match.id, match]))
        if (map.size !== chunk.length || matches.length !== chunk.length || chunk.some(item => !map.has(item.id)) || matches.some(match => typeof match.duplicate !== 'boolean')) throw new Error('Invalid preflight response')
        for (const item of chunk) {
          const match = map.get(item.id)!
          if (match.duplicate) {
            item.state = 'duplicate'; item.reason = 'serverDuplicate'
            item.duplicateName = [match.folder_path, match.file_name].filter(Boolean).join('/')
            // Existing IDs must never become rollback targets.
          } else item.state = 'waiting'
        }
      }
      this.batch.checking = false
      const queue = candidates.filter(item => item.state === 'waiting')
      let cursor = 0
      let networkFailures = 0
      const worker = async () => {
        while (!signal.aborted && cursor < queue.length) {
          const item = queue[cursor++]!
          item.state = 'uploading'
          try {
            const result = await this.deps.upload(item, signal, percent => { item.progress = Math.max(0, Math.min(100, percent)) })
            if (!result?.id) throw new Error('Upload response did not contain a document ID')
            item.state = 'uploaded'; item.progress = 100
            item.knowledgeId = result.id; item.parseStatus = result.parse_status || 'pending'
            networkFailures = 0
            this.deps.accepted?.(item)
          } catch (error: any) {
            if (duplicateError(error)) {
              item.state = 'duplicate'; item.reason = 'serverDuplicate'
              item.duplicateName = error?.data?.file_name
            } else if (signal.aborted) {
              item.state = 'uncertain'; item.reason = 'uncertainHint'
            } else {
              const status = error?.$httpStatus || error?.status
              item.state = status ? 'failed' : 'uncertain'
              item.error = errorMessage(error)
              if (!status) networkFailures++
              if (status === 401 || status === 403 || networkFailures >= 3) {
                this.batch.error = item.error
                this.stop()
              }
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker))
    } catch (error) {
      if (!signal.aborted) {
        this.batch.error = errorMessage(error)
        for (const item of items.filter(pending)) { item.state = 'failed'; item.reason = 'preflightFailed'; item.error = this.batch.error }
      }
    } finally {
      for (const item of items.filter(pending)) if (signal.aborted) item.state = 'cancelled'
      this.batch.running = false
      this.batch.checking = false
    }
  }
}

export function uploadCounts(batch: UploadBatch) {
  const count = (states: UploadState[]) => batch.items.filter(item => states.includes(item.state)).length
  return {
    total: batch.items.length,
    uploaded: count(['uploaded']), duplicate: count(['duplicate']), failed: count(['failed', 'uncertain']),
    cancelled: count(['cancelled']), removed: count(['removed']),
    settled: count(['uploaded', 'duplicate', 'failed', 'uncertain', 'cancelled', 'removed']),
  }
}

export function rollbackIDs(batch: UploadBatch): string[] {
  return [...new Set(batch.items.filter(item => item.knowledgeId && item.state !== 'removed').map(item => item.knowledgeId!))]
}
