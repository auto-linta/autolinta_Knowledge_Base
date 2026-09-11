<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useKnowledgeUploadsStore } from '@/stores/knowledgeUploads'
import { rollbackIDs, uploadCounts, type UploadBatch, type UploadItem } from '@/utils/knowledgeUploadQueue'

const store = useKnowledgeUploadsStore()
const { t, te } = useI18n()
const expanded = ref(true)
const tasks = computed(() => store.visibleBatches.map(batch => ({ batch, counts: uploadCounts(batch) })))
watch(() => store.visibleBatches.length, (count, previous) => { if (count > previous) expanded.value = true })
const canRetry = (batch: UploadBatch) => batch.items.some(item => ['failed', 'uncertain', 'cancelled'].includes(item.state))
const parseLabel = (item: UploadItem) => {
  const status = item.parseStatus || 'pending'
  const key = `knowledgeBase.parseStatus${status[0]!.toUpperCase()}${status.slice(1)}`
  return te(key) ? t(key) : t('knowledgeUpload.statusUnknown')
}
const guardLeave = (event: BeforeUnloadEvent) => {
  if (store.busy) { event.preventDefault(); event.returnValue = '' }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  window.addEventListener('beforeunload', guardLeave)
  timer = setInterval(() => { void store.refresh() }, 5000)
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', guardLeave)
  if (timer) clearInterval(timer)
})
</script>

<template>
  <aside v-if="tasks.length" class="upload-tasks" :aria-label="t('knowledgeUpload.title')">
    <button class="upload-tasks__header" :aria-expanded="expanded" @click="expanded = !expanded">
      <span>{{ t('knowledgeUpload.title') }} · {{ tasks.length }}</span>
      <span>{{ expanded ? t('knowledgeUpload.collapse') : t('knowledgeUpload.expand') }}</span>
    </button>
    <div v-if="expanded" class="upload-tasks__body">
      <p class="upload-tasks__hint">{{ t('knowledgeUpload.leaveHint') }}</p>
      <section v-for="{ batch, counts } in tasks" :key="batch.id" class="upload-batch">
        <div class="upload-batch__title">
          <strong>{{ batch.kbName }}</strong>
          <span>{{ t('knowledgeUpload.total', { count: counts.total }) }}</span>
        </div>
        <p v-if="batch.queued" role="status">{{ t('knowledgeUpload.queued') }}</p>
        <p v-else-if="batch.checking" role="status">{{ t('knowledgeUpload.checkingHint', { count: batch.items.filter(item => item.hash).length, total: counts.total }) }}</p>
        <progress class="upload-batch__progress" :value="counts.settled" :max="counts.total" :aria-label="t('knowledgeUpload.progress')" />
        <div class="upload-batch__counts" role="status" aria-live="polite">
          <span>{{ t('knowledgeUpload.receivedCount', { count: counts.uploaded }) }}</span>
          <span>{{ t('knowledgeUpload.duplicateCount', { count: counts.duplicate }) }}</span>
          <span>{{ t('knowledgeUpload.failedCount', { count: counts.failed }) }}</span>
          <span v-if="counts.cancelled">{{ t('knowledgeUpload.cancelledCount', { count: counts.cancelled }) }}</span>
          <span v-if="counts.removed">{{ t('knowledgeUpload.removedCount', { count: counts.removed }) }}</span>
        </div>
        <p v-if="batch.error" class="upload-tasks__error">{{ batch.error }}</p>
        <p v-if="batch.notice" class="upload-tasks__hint">{{ t(`knowledgeUpload.${batch.notice}`) }}</p>
        <div class="upload-batch__actions">
          <t-button v-if="batch.running || batch.queued" size="small" variant="outline" @click="store.stop(batch)">{{ t('knowledgeUpload.stop') }}</t-button>
          <t-button v-if="canRetry(batch) && !batch.running && !batch.queued" size="small" variant="outline" :disabled="batch.revoking" @click="store.retry(batch)">{{ t('knowledgeUpload.retry') }}</t-button>
          <t-popconfirm v-if="rollbackIDs(batch).length" :content="t('knowledgeUpload.rollbackConfirm', { count: rollbackIDs(batch).length })" @confirm="store.rollback(batch)">
            <t-button size="small" theme="danger" variant="outline" :loading="batch.revoking" :disabled="batch.running || batch.queued || batch.revoking">{{ t('knowledgeUpload.rollback') }}</t-button>
          </t-popconfirm>
          <t-button size="small" variant="text" :disabled="batch.running || batch.queued || batch.revoking" @click="store.dismiss(batch)">{{ t('knowledgeUpload.dismiss') }}</t-button>
        </div>
        <details class="upload-batch__details" open>
          <summary>{{ t('knowledgeUpload.files') }}</summary>
          <ol class="upload-batch__files">
            <li v-for="item in batch.items" :key="item.id" :class="['upload-file', { 'upload-file--error': ['failed', 'uncertain'].includes(item.state) || item.parseStatus === 'failed' }]">
              <div class="upload-file__path" :title="item.path">{{ item.path }}</div>
              <div class="upload-file__status">
                <span>{{ t(`knowledgeUpload.state.${item.state}`) }}</span>
                <span v-if="item.state === 'uploading'">{{ Math.floor(item.progress) }}%</span>
                <span v-if="item.state === 'uploaded'"> · {{ t('knowledgeUpload.parsing') }}{{ parseLabel(item) }}</span>
              </div>
              <progress v-if="item.state === 'uploading'" :value="item.progress" max="100" :aria-label="item.path" />
              <small v-if="item.reason">{{ t(`knowledgeUpload.${item.reason}`) }}</small>
              <small v-if="item.duplicateName">{{ item.duplicateName }}</small>
              <small v-if="item.error || item.parseError">{{ item.error || item.parseError }}</small>
            </li>
          </ol>
        </details>
      </section>
    </div>
  </aside>
</template>

<style scoped lang="less">
.upload-tasks { position: fixed; right: 24px; bottom: 20px; z-index: 1600; width: min(460px, calc(100vw - 32px)); color: var(--td-text-color-primary); background: var(--td-bg-color-container); border: 1px solid var(--td-component-stroke); border-radius: 12px; box-shadow: var(--td-shadow-3); overflow: hidden; }
.upload-tasks__header { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 14px 16px; border: 0; background: var(--td-bg-color-secondarycontainer); color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.upload-tasks__body { padding: 0 16px 12px; max-height: min(72vh, 700px); overflow-y: auto; }
.upload-tasks__hint { color: var(--td-text-color-secondary); font-size: 12px; line-height: 1.6; }
.upload-tasks__error { color: var(--td-error-color); overflow-wrap: anywhere; }
.upload-batch { padding: 14px 0; border-top: 1px solid var(--td-component-stroke); }
.upload-batch__title { display: flex; justify-content: space-between; gap: 12px; strong { overflow-wrap: anywhere; } span { white-space: nowrap; color: var(--td-text-color-secondary); } }
.upload-batch__progress { width: 100%; height: 6px; margin: 12px 0; accent-color: var(--td-brand-color); }
.upload-batch__counts { display: flex; gap: 6px 16px; flex-wrap: wrap; font-size: 12px; }
.upload-batch__actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
.upload-batch__details summary { cursor: pointer; font-size: 12px; }
.upload-batch__files { list-style: none; padding: 0; max-height: 250px; overflow-y: auto; }
.upload-file { padding: 10px 4px; border-bottom: 1px solid var(--td-component-stroke); font-size: 12px; small { display: block; color: var(--td-text-color-secondary); overflow-wrap: anywhere; margin-top: 4px; } progress { width: 100%; height: 4px; accent-color: var(--td-brand-color); } }
.upload-file__path { overflow-wrap: anywhere; line-height: 1.5; }
.upload-file__status { display: flex; flex-wrap: wrap; gap: 6px; color: var(--td-text-color-secondary); margin-top: 4px; }
.upload-file--error .upload-file__status { color: var(--td-error-color); }
</style>
