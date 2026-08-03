import axios from 'axios';
import {
  ENDPOINTS,
  API_BASE_URL,
  API_TIMEOUT,
  RETRY_COUNT
} from '../utils/constants';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens
} from './storage';
import { mapBackendError } from '../utils/errorMapping';

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT
});

let refreshing = null;
const AUTH_SCHEME = 'Bearer';
const toAuthorizationHeader = (token) => `${AUTH_SCHEME} ${token}`;

const retryRequest = async (fn, retries = RETRY_COUNT, wait = 100) => {
  let lastError;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, wait * 2 ** i));
    }
  }
  throw lastError;
};

api.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = toAuthorizationHeader(token);
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config || {};
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      refreshing =
        refreshing ||
        (async () => {
          const refreshToken = await getRefreshToken();
          const response = await axios.post(
            `${API_BASE_URL}${ENDPOINTS.refresh}`,
            { refreshToken }
          );
          await setTokens(response.data);
          refreshing = null;
          return response.data.accessToken;
        })();
      try {
        const token = await refreshing;
        original.headers = original.headers || {};
        original.headers.Authorization = toAuthorizationHeader(token);
        return api(original);
      } catch (refreshError) {
        refreshing = null;
        await clearTokens();
        throw refreshError;
      }
    }
    throw error;
  }
);

const safeCall = async (fn) => {
  try {
    return await retryRequest(fn);
  } catch (error) {
    const code =
      error.response?.data?.code ||
      (error.message === 'Network Error' ? 'NETWORK_ERROR' : 'SERVER_ERROR');
    throw new Error(mapBackendError(code));
  }
};

const scanProduct = (data) => safeCall(() => api.post(ENDPOINTS.scans, data));

export const endpoints = {
  login: (data) => safeCall(() => api.post(ENDPOINTS.login, data)),
  signup: (data) => safeCall(() => api.post(ENDPOINTS.signup, data)),
  logout: () => safeCall(() => api.post(ENDPOINTS.logout)),
  refresh: (data) => safeCall(() => api.post(ENDPOINTS.refresh, data)),
  forgotPassword: (data) =>
    safeCall(() => api.post(ENDPOINTS.forgotPassword, data)),
  resetPassword: (data) =>
    safeCall(() => api.post(ENDPOINTS.resetPassword, data)),
  getProfile: () => safeCall(() => api.get(ENDPOINTS.profile)),
  updateProfile: (data) => safeCall(() => api.put(ENDPOINTS.profile, data)),
  scanProduct,
  scanBarcode: scanProduct,
  getAlternatives: ({ barcode, category, name, goals } = {}) =>
    safeCall(() => api.get(`${ENDPOINTS.alternatives}/${encodeURIComponent(barcode || '')}`, {
      params: {
        ...(category ? { category } : {}),
        ...(name ? { name } : {}),
        ...(goals && goals.length ? { goals: goals.join(',') } : {})
      }
    })),
  addSavedItem: (data) => safeCall(() => api.post(ENDPOINTS.savedItems, data)),
  removeSavedItem: (id) =>
    safeCall(() => api.delete(`${ENDPOINTS.savedItems}/${id}`)),
  getSavedItems: () => safeCall(() => api.get(ENDPOINTS.savedItems)),
  submitCorrection: (data) =>
    safeCall(() => api.post(ENDPOINTS.corrections, data))
};
