<script setup lang="ts">
import DefaultTheme from "vitepress/theme-without-fonts";
import StatusBanner from "./components/StatusBanner.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #layout-top>
      <StatusBanner />
    </template>
  </Layout>
</template>
