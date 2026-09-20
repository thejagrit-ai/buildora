import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Each theme maps to a [data-theme] block in src/index.css. `swatch` is used to
// render a little preview dot in the theme picker. `dark` flips the picker icon.
export interface ThemeDef {
  id: string;
  label: string;
  swatch: string; // accent colour for the preview dot
  dark?: boolean;
}

export const THEMES: ThemeDef[] = [
  { id: 'buildora', label: 'Buildora', swatch: '#c46f43' },
  { id: 'midnight', label: 'Midnight', swatch: '#c88961', dark: true },
];

const DEFAULT_THEME = 'buildora';

export function applyTheme(id: string) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  document.documentElement.setAttribute('data-theme', theme.id);
}

interface ThemeState {
  theme: string;
  setTheme: (id: string) => void;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME,
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
    }),
    {
      name: 'buildora-theme',
      // Re-apply the persisted theme to the DOM as soon as the store rehydrates.
      onRehydrateStorage: () => (state) => {
        applyTheme(state?.theme ?? DEFAULT_THEME);
      },
    },
  ),
);
