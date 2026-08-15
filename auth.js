// ===============================================================
// 🔐 DPQSL AUTH & RBAC HELPER
// Shared by index.html. Not used by login.html or dashboard.html
// (dashboard.html is public and needs no auth at all).
// ===============================================================

// Works automatically on localhost AND after deployment (Render etc.)
const AUTH_BASE_URL = window.location.origin;

// Which modules each role is allowed to open (mirrors the backend authorizeRoles rules)
const MODULE_ACCESS = {
  operator:   ['ADMIN', 'IE_PLANNING'],
  sam:        ['ADMIN', 'IE_PLANNING'],
  assign:     ['ADMIN', 'IE_PLANNING'],
  production: ['ADMIN', 'LINE_SUPERVISOR']
};

function getToken() {
  return localStorage.getItem('token');
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('user'));
  } catch (e) {
    return null;
  }
}

// Decodes a JWT payload client-side (no signature check — just for expiry/UX, the
// server always re-validates the signature on every request).
function decodeJwtPayload(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch (e) {
    return null;
  }
}

function isTokenExpired(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  return Date.now() >= payload.exp * 1000;
}

// Call at the top of any protected page. Redirects to login.html if there's no
// valid, unexpired token. Returns true/false so callers can bail out early.
function requireAuth() {
  const token = getToken();
  if (!token || isTokenExpired(token)) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
    return false;
  }
  return true;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}

// Drop-in replacement for fetch() that automatically attaches the JWT and
// force-logs-out on a 401 (expired/invalid token).
async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = Object.assign({}, options.headers || {}, {
    Authorization: token ? `Bearer ${token}` : ''
  });

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    logout();
    throw new Error('Session expired. Please log in again.');
  }

  return response;
}

function isModuleAllowed(user, moduleName) {
  if (!user) return false;
  const allowedRoles = MODULE_ACCESS[moduleName];
  return !!allowedRoles && allowedRoles.includes(user.role);
}

// Hides/shows nav items and the "Add Operator" form based on the logged-in user's role.
function applyRoleBasedUI(user) {
  if (!user) return;

  document.getElementById('userNameLabel').textContent = user.full_name || user.username;
  document.getElementById('userRoleLabel').textContent = user.role.replace('_', ' ');

  const navMap = {
    navOperator: 'operator',
    navSam: 'sam',
    navAssign: 'assign',
    navProduction: 'production'
  };

  Object.entries(navMap).forEach(([navId, moduleName]) => {
    const el = document.getElementById(navId);
    if (!el) return;
    if (isModuleAllowed(user, moduleName)) {
      el.removeAttribute('data-hidden');
    } else {
      el.setAttribute('data-hidden', 'true');
    }
  });

  // IE_PLANNING is view-only on Operator Master List — hide the add/edit form entirely
  const operatorFormCard = document.getElementById('operatorFormCard');
  if (operatorFormCard) {
    operatorFormCard.style.display = (user.role === 'IE_PLANNING') ? 'none' : '';
  }
  const bulkUploadCard = document.getElementById('bulkUploadCard');
  if (bulkUploadCard) {
    bulkUploadCard.style.display = (user.role === 'IE_PLANNING') ? 'none' : '';
  }
}