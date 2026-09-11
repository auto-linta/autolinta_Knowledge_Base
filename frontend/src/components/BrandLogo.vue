<template>
  <span class="brand-logo" :class="{ 'brand-logo--inverse': inverse, 'brand-logo--compact': compact }">
    <svg class="brand-logo__mark" viewBox="0 0 42 30" aria-hidden="true">
      <path d="M2 24.5C10.4 17.8 17.8 13 25.8 9.8C30.3 8 35.1 6.7 40 6" />
      <path d="M11 25.5C17.8 20.7 24.2 17.6 31.7 15.8C34.2 15.2 36.9 14.8 40 14.7" />
      <path d="M26.5 24.8C31.1 22.3 35.5 21.2 40 21.2" />
    </svg>
    <span class="brand-logo__wordmark">
      <span>Auto</span><strong>Linta</strong>
    </span>
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  inverse?: boolean
  compact?: boolean
}>(), {
  inverse: false,
  compact: false,
})
</script>

<style scoped>
.brand-logo {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: #101113;
  line-height: 1;
  user-select: none;
}

.brand-logo--inverse {
  color: #fff;
}

.brand-logo__mark {
  width: 38px;
  height: 28px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 3.4;
  stroke-linecap: round;
}

.brand-logo__wordmark {
  font-family: Arial, "Helvetica Neue", sans-serif;
  font-size: 22px;
  font-weight: 850;
  letter-spacing: -1.35px;
  white-space: nowrap;
}

.brand-logo__wordmark strong {
  color: #f92815;
  font-weight: 850;
}

.brand-logo--compact {
  gap: 6px;
}

.brand-logo--compact .brand-logo__mark {
  width: 30px;
  height: 22px;
}

.brand-logo--compact .brand-logo__wordmark {
  font-size: 18px;
  letter-spacing: -1.05px;
}
</style>
