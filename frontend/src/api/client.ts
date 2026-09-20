import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuth } from '../store/auth';

const baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api';

export const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = useAuth.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Single-flight refresh: queue concurrent 401s behind one refresh call.
let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken, setTokens, clear } = useAuth.getState();
  if (!refreshToken) return null;
  try {
    const { data } = await axios.post(`${baseURL}/auth/refresh`, { refreshToken });
    setTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    clear();
    return null;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status === 401 && original && !original._retry) {
      original._retry = true;
      refreshing = refreshing ?? refreshAccessToken();
      const token = await refreshing;
      refreshing = null;
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

export function apiErrorMessage(err: unknown): string {
  const e = err as AxiosError<{ error?: { message?: string } }>;
  return e?.response?.data?.error?.message ?? e?.message ?? 'Something went wrong';
}
