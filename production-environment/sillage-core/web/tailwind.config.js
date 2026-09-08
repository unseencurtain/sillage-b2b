import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [join(dir, "index.html"), join(dir, "src/**/*.{ts,tsx}")],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)",
        panel: "var(--panel)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        accent: "var(--accent)",
        "accent-ink": "var(--accent-ink)",
        danger: "var(--danger)",
        warn: "var(--warn)",
        ok: "var(--ok)",
        sidebar: "var(--sidebar)",
        "sidebar-ink": "var(--sidebar-ink)",
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
