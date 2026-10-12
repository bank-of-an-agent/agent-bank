import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import type { Theme } from "vitepress";
// The default theme without its bundled Inter: the fonts above are self-hosted
// from npm (no runtime font fetch) and named in custom.css.
import DefaultTheme from "vitepress/theme-without-fonts";
import "./custom.css";
import KeyTrio from "./components/KeyTrio.vue";
import Layout from "./Layout.vue";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("KeyTrio", KeyTrio);
  },
} satisfies Theme;
