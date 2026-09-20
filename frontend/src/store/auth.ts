import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel?: string;
  partnerAccountId?: string | null;
  permissions?: string[];
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  setTokens: (a: string, r: string) => void;
  setUser: (u: AuthUser) => void;
  clear: () => void;
  can: (perm: string) => boolean;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setUser: (user) => set({ user }),
      clear: () => set({ accessToken: null, refreshToken: null, user: null }),
      can: (perm) => {
        const u = get().user;
        if (!u) return false;
        if (u.role === 'SUPER_ADMIN') return true;
        return (u.permissions ?? []).includes(perm);
      },
    }),
    // Bearer tokens remain accessible to the SPA, so persistence is deliberately
    // session-only. A future HttpOnly refresh-session migration can remove this
    // client-side token exposure altogether.
    { name: 'buildora-auth', storage: createJSONStorage(() => sessionStorage) },
  ),
);
