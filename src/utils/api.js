const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

/**
 * Generic API fetch helper handling JSON response & JWT headers
 */
export async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('authToken');

  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || data.error || 'API Request Failed');
  }

  return data;
}

// Product Service Methods
export const getProducts = (search = '', page = 1) => 
  apiRequest(`/products?search=${encodeURIComponent(search)}&page=${page}`);

export const getProductById = (id) => 
  apiRequest(`/products/${id}`);

// Order Service Methods
export const createOrder = (orderPayload) => 
  apiRequest('/orders', {
    method: 'POST',
    body: JSON.stringify(orderPayload),
  });