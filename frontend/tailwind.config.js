/** @type {import('tailwindcss').Config} */

// Colors are driven by CSS variables (see src/index.css) so the whole UI can be
// re-themed at runtime by swapping `data-theme` on <html>. Each variable holds a
// space-separated "R G B" triplet, consumed via rgb(var(--x) / <alpha-value>) so
// Tailwind opacity modifiers (e.g. bg-surface/80) keep working.
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Panel/card background (was literal bg-white).
        surface: v('--c-surface'),
        // Neutral scale — every shade the app uses.
        slate: {
          50: v('--c-slate-50'),
          100: v('--c-slate-100'),
          200: v('--c-slate-200'),
          300: v('--c-slate-300'),
          400: v('--c-slate-400'),
          500: v('--c-slate-500'),
          600: v('--c-slate-600'),
          700: v('--c-slate-700'),
          800: v('--c-slate-800'),
          900: v('--c-slate-900'),
        },
        // Accent / primary.
        brand: {
          DEFAULT: v('--c-brand-600'),
          50: v('--c-brand-50'),
          100: v('--c-brand-100'),
          500: v('--c-brand-500'),
          600: v('--c-brand-600'),
          700: v('--c-brand-700'),
        },
        // Fixed (non-themed) cyanotype navy for the login "site plan" panel —
        // deliberately stays constant across all 6 client themes, like a
        // blueprint always reads as a blueprint regardless of who it's for.
        blueprint: {
          900: '#0a2240',
          800: '#0f2e54',
          700: '#163d6b',
        },
      },
      borderColor: {
        // Bare `border` utility follows the themed neutral border.
        DEFAULT: v('--c-slate-200'),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'ui-serif', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
