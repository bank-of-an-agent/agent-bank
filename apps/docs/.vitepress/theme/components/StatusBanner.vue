<script setup lang="ts">
import { withBase } from "vitepress";

/**
 * Site-wide status line. Its height is `--vp-layout-top-height`, which the
 * default theme uses to push the nav, sidebar and content down.
 */
const href = withBase("/concepts/regulatory-posture");
</script>

<template>
  <div class="ab-status" role="note" aria-label="Project status">
    <span class="ab-status-pill">Pre-release</span>
    <span class="ab-status-text">
      Testnet only (Base Sepolia)
      <span class="ab-status-more"
        >· contracts unaudited · not a bank or money transmitter · not legal advice</span
      >
    </span>
    <a class="ab-status-link" :href="href">Details</a>
  </div>
</template>

<style scoped>
.ab-status {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: var(--vp-z-index-layout-top);
  height: var(--vp-layout-top-height);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 16px;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  color: var(--ab-status-text);
  background: var(--ab-status-bg);
  border-bottom: 1px solid var(--ab-status-border);
}

.ab-status-pill {
  flex: none;
  padding: 4px 8px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ab-owner);
  background: var(--ab-owner-soft);
}

.ab-status-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ab-status-more {
  display: none;
}

.ab-status-link {
  flex: none;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 2px;
}

@media (min-width: 900px) {
  .ab-status-more {
    display: inline;
  }
}
</style>
