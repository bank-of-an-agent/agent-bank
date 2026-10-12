<script setup lang="ts">
/** The three keys of every Agent Bank account, in the brand colours of the mark. */
const keys = [
  {
    id: "owner",
    name: "Owner key",
    holder: "Held by you, the principal: a passkey or hardware wallet. Agent Bank never holds it.",
    alone: "Everything: withdraw all funds, remove the co-signer, rotate keys, exit without Agent Bank.",
  },
  {
    id: "session",
    name: "Session key",
    holder: "Held by the agent runtime. Generated client-side by the SDK, 24 hours by default.",
    alone: "Nothing. It signs requests and operations inside an on-chain scope; the co-signer must sign too.",
  },
  {
    id: "cosigner",
    name: "Co-signer",
    holder: "Held by Agent Bank as a non-exportable KMS key, in a separate cloud account.",
    alone: "Nothing. It re-checks the owner's policy and approves or refuses each agent operation.",
  },
] as const;
</script>

<template>
  <div class="ab-keys">
    <section v-for="key in keys" :key="key.id" class="ab-key" :class="`ab-key-${key.id}`">
      <h3 class="ab-key-name"><span class="ab-key-dot" aria-hidden="true"></span>{{ key.name }}</h3>
      <p class="ab-key-holder">{{ key.holder }}</p>
      <p class="ab-key-alone"><strong>Can do alone:</strong> {{ key.alone }}</p>
    </section>
  </div>
  <p class="ab-rule">
    <code>valid = owner ∨ (session ∧ co-signer ∧ policy)</code>
  </p>
</template>

<style scoped>
.ab-keys {
  display: grid;
  gap: 16px;
  margin: 24px 0 8px;
}

@media (min-width: 768px) {
  .ab-keys {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.ab-key {
  border: 1px solid var(--vp-c-divider);
  border-top: 3px solid var(--ab-key-color);
  border-radius: 12px;
  padding: 18px 20px;
  background: var(--vp-c-bg-soft);
}

.ab-key-owner {
  --ab-key-color: var(--ab-owner);
}

.ab-key-session {
  --ab-key-color: var(--ab-session);
}

.ab-key-cosigner {
  --ab-key-color: var(--ab-cosigner);
}

.vp-doc .ab-key-name {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  padding: 0;
  border: none;
  font-size: 17px;
}

.ab-key-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--ab-key-color);
  box-shadow:
    0 0 0 3px var(--vp-c-bg-soft),
    0 0 0 4px var(--ab-key-color);
}

.vp-doc .ab-key p {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 1.6;
}

.ab-key-holder {
  color: var(--vp-c-text-2);
}

.vp-doc .ab-rule {
  margin: 16px 0 0;
  text-align: center;
}

.vp-doc .ab-rule code {
  font-size: 15px;
  padding: 8px 14px;
  color: var(--vp-c-text-1);
}
</style>
