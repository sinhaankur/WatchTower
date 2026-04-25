import axios from 'axios';

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || '/api';
const API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN;
const DEV_FALLBACK_TOKEN = (import.meta as any).env?.DEV ? 'dev-token' : undefined;

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add authorization token if available
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('authToken') || API_TOKEN || DEV_FALLBACK_TOKEN;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Centralised response handling: surface auth failures consistently and
// avoid silent UI hangs. We only redirect on 401 when there's actually a
// session token in localStorage (so anonymous /login page calls don't loop).
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    if (status === 401) {
      const hadSession = !!localStorage.getItem('authToken');
      if (hadSession) {
        try {
          localStorage.removeItem('authToken');
        } catch {
          /* ignore */
        }
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.replace(`/login?next=${next}`);
        }
      }
    }
    return Promise.reject(error);
  },
);

export default apiClient;
