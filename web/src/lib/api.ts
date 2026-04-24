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

export default apiClient;
