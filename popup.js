// ─────────────────────────────────────────────────────────────
//  popup.js  –  Myntra Order Automation – Auth + Config popup
//  Email+Password auth via MOA License Server
// ─────────────────────────────────────────────────────────────
'use strict';

const API_BASE_URL = 'https://mtool-authapi.onrender.com';

const STORAGE_KEYS = {
  AUTH: 'moaAuth',
  CONFIG: 'moaConfig',
};

const DEFAULTS = {
  invoicePrinter: 'TSC DA310',
  labelPrinter: 'TSC DA310',
  defaultCoverId: 'myntra123',
  askCoverIdPerOrder: false,
  stepDelay: 1500,
  pauseOnSkuChange: true,
  pdfSavePath: 'MyntraOrders',
  pdfGroupBySku: true,
};

// ── DOM refs ──────────────────────────────────────────────────
const authScreen = document.getElementById('auth-screen');
const settingsScreen = document.getElementById('settings-screen');
const subBar = document.getElementById('sub-bar');
const subPlanBadge = document.getElementById('sub-plan-badge');
const subExpiry = document.getElementById('sub-expiry');
const btnLogout = document.getElementById('btn-logout');

// Auth tabs
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');

// Login form
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const btnLogin = document.getElementById('btn-login');

// Register form
const regName = document.getElementById('reg-name');
const regEmail = document.getElementById('reg-email');
const regPassword = document.getElementById('reg-password');
const regError = document.getElementById('reg-error');
const regSuccess = document.getElementById('reg-success');
const btnRegister = document.getElementById('btn-register');

// Settings
const cfgInvoicePrinter = document.getElementById('cfg-invoice-printer');
const cfgLabelPrinter = document.getElementById('cfg-label-printer');
const cfgCoverId = document.getElementById('cfg-cover-id');
const cfgScanPerOrder = document.getElementById('cfg-scan-per-order');
const cfgDelay = document.getElementById('cfg-delay');
const cfgPauseOnSku = document.getElementById('cfg-pause-sku');
const cfgPdfPath = document.getElementById('cfg-pdf-path');
const cfgPdfGroupSku = document.getElementById('cfg-pdf-group-sku');
const saveIndicator = document.getElementById('save-indicator');
const btnRefresh = document.getElementById('btn-refresh-printers');
const printerStatus = document.getElementById('printer-status');
const refreshIcon = document.getElementById('refresh-icon');

// ══════════════════════════════════════════════════════════════
//  AUTH TABS
// ══════════════════════════════════════════════════════════════
tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  formLogin.classList.remove('hidden');
  formRegister.classList.add('hidden');
  loginError.classList.remove('show');
});
tabRegister.addEventListener('click', () => {
  tabRegister.classList.add('active');
  tabLogin.classList.remove('active');
  formRegister.classList.remove('hidden');
  formLogin.classList.add('hidden');
  regError.classList.remove('show');
  regSuccess.classList.remove('show');
});

// ══════════════════════════════════════════════════════════════
//  AUTH FLOW
// ══════════════════════════════════════════════════════════════

function showAuth(errorMsg) {
  authScreen.classList.remove('hidden');
  settingsScreen.classList.remove('visible');
  subBar.classList.add('hidden');
  if (errorMsg) {
    loginError.textContent = errorMsg;
    loginError.classList.add('show');
  }
}

function showSettings(user) {
  authScreen.classList.add('hidden');
  settingsScreen.classList.add('visible');
  subBar.classList.remove('hidden');
  updateSubBar(user);
}

function updateSubBar(user) {
  if (!user) return;
  subPlanBadge.textContent = 'FREE';
  subPlanBadge.className = 'sub-plan';
  subExpiry.textContent = 'Unlimited Access';
  subExpiry.className = 'sub-expiry';
}

// API helper
async function apiRequest(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${API_BASE_URL}${path}`, opts);

  let data = {};
  try {
    const text = await resp.text();
    if (text) data = JSON.parse(text);
  } catch (e) {
    console.error('API Parse Error:', e);
  }

  return { status: resp.status, data };
}

// ── Login ────────────────────────────────────────────────────
formLogin.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email || !password) {
    loginError.textContent = 'Enter email and password';
    loginError.classList.add('show');
    return;
  }

  btnLogin.disabled = true;
  btnLogin.innerHTML = '<span class="spinner"></span> Logging in…';
  loginError.classList.remove('show');

  try {
    const { status, data } = await apiRequest('POST', '/api/moa/login', { email, password });

    if (data.success) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.AUTH]: {
          accessToken: data.tokens.accessToken,
          refreshToken: data.tokens.refreshToken,
          user: data.user,
        },
      });
      showSettings(data.user);
      loadConfig();
      fetchPrinters();
    } else {
      loginError.textContent = data.message || 'Login failed';
      loginError.classList.add('show');
    }
  } catch {
    loginError.textContent = 'Cannot connect to server. Check internet.';
    loginError.classList.add('show');
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = 'Login';
  }
});

// ── Register ─────────────────────────────────────────────────
formRegister.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = regName.value.trim();
  const email = regEmail.value.trim();
  const password = regPassword.value;

  if (!name || !email || !password) {
    regError.textContent = 'All fields are required';
    regError.classList.add('show');
    return;
  }

  btnRegister.disabled = true;
  btnRegister.innerHTML = '<span class="spinner"></span> Creating account…';
  regError.classList.remove('show');
  regSuccess.classList.remove('show');

  try {
    const { status, data } = await apiRequest('POST', '/api/moa/register', { name, email, password });

    if (data.success) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.AUTH]: {
          accessToken: data.tokens.accessToken,
          refreshToken: data.tokens.refreshToken,
          user: data.user,
        },
      });
      showSettings(data.user);
      loadConfig();
      fetchPrinters();
    } else {
      regError.textContent = data.message || 'Registration failed';
      regError.classList.add('show');
    }
  } catch {
    regError.textContent = 'Cannot connect to server. Check internet.';
    regError.classList.add('show');
  } finally {
    btnRegister.disabled = false;
    btnRegister.textContent = 'Create Account & Start Free';
  }
});

// ── Check Auth on Popup Open ─────────────────────────────────
async function checkAuth() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.AUTH);
  let auth = result[STORAGE_KEYS.AUTH];

  if (!auth || !auth.user) {
    auth = {
      accessToken: 'free_token',
      refreshToken: 'free_refresh',
      user: { name: 'Free Access User', email: 'free@moa.local' }
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.AUTH]: auth });
  }

  showSettings(auth.user);
  loadConfig();
  fetchPrinters();
}

// ── Logout ───────────────────────────────────────────────────
btnLogout.addEventListener('click', async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.AUTH);
  showAuth();
  loginEmail.value = '';
  loginPassword.value = '';
});

// ══════════════════════════════════════════════════════════════
//  CONFIG MANAGEMENT
// ══════════════════════════════════════════════════════════════

let currentConfig = { ...DEFAULTS };

async function loadConfig() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  currentConfig = { ...DEFAULTS, ...(result[STORAGE_KEYS.CONFIG] || {}) };

  [cfgInvoicePrinter, cfgLabelPrinter].forEach(sel => {
    const val = sel === cfgInvoicePrinter ? currentConfig.invoicePrinter : currentConfig.labelPrinter;
    if (val && !Array.from(sel.options).some(o => o.value === val)) {
      sel.add(new Option(val, val));
    }
    sel.value = val;
  });

  cfgCoverId.value = currentConfig.defaultCoverId;
  cfgScanPerOrder.checked = currentConfig.askCoverIdPerOrder;
  cfgDelay.value = currentConfig.stepDelay;
  cfgPauseOnSku.checked = currentConfig.pauseOnSkuChange;
  cfgPdfPath.value = currentConfig.pdfSavePath;
  cfgPdfGroupSku.checked = currentConfig.pdfGroupBySku;
}

async function fetchPrinters() {
  btnRefresh.disabled = true;
  refreshIcon.classList.add('spin');
  printerStatus.textContent = 'Fetching printers...';
  printerStatus.className = 'printer-status';

  chrome.runtime.sendMessage({ action: 'GET_PRINTERS' }, (response) => {
    btnRefresh.disabled = false;
    refreshIcon.classList.remove('spin');

    if (chrome.runtime.lastError || !response) {
      printerStatus.textContent = 'Extension error. Please reload.';
      printerStatus.className = 'printer-status err';
      return;
    }
    if (!response.success) {
      printerStatus.textContent = response.error || 'Failed to fetch printers.';
      printerStatus.className = 'printer-status err';
      return;
    }
    const printers = response.printers || [];
    if (printers.length === 0) {
      printerStatus.textContent = 'No printers found.';
      printerStatus.className = 'printer-status err';
      return;
    }

    [cfgInvoicePrinter, cfgLabelPrinter].forEach(sel => {
      const currentVal = sel.value;
      sel.innerHTML = '';
      const stdPdfOptions = ['Save as PDF', 'Microsoft Print to PDF'];
      const allPrinters = Array.from(new Set([...stdPdfOptions, ...printers]));

      allPrinters.forEach(p => sel.add(new Option(p, p)));

      if (allPrinters.includes(currentVal)) {
        sel.value = currentVal;
      } else if (sel === cfgInvoicePrinter && allPrinters.includes(currentConfig.invoicePrinter)) {
        sel.value = currentConfig.invoicePrinter;
      } else if (sel === cfgLabelPrinter && allPrinters.includes(currentConfig.labelPrinter)) {
        sel.value = currentConfig.labelPrinter;
      } else {
        sel.value = 'Save as PDF';
      }
    });

    printerStatus.textContent = `Found ${printers.length} printer(s).`;
    printerStatus.className = 'printer-status ok';
    saveConfig();
  });
}

let saveTimeout = null;
function saveConfig() {
  const cfg = {
    invoicePrinter: cfgInvoicePrinter.value.trim() || DEFAULTS.invoicePrinter,
    labelPrinter: cfgLabelPrinter.value.trim() || DEFAULTS.labelPrinter,
    defaultCoverId: cfgCoverId.value.trim() || DEFAULTS.defaultCoverId,
    askCoverIdPerOrder: cfgScanPerOrder.checked,
    stepDelay: parseInt(cfgDelay.value, 10) || DEFAULTS.stepDelay,
    pauseOnSkuChange: cfgPauseOnSku.checked,
    pdfSavePath: cfgPdfPath.value.trim() || DEFAULTS.pdfSavePath,
    pdfGroupBySku: cfgPdfGroupSku.checked,
  };
  chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: cfg });
  currentConfig = cfg;
  saveIndicator.textContent = '✓ Settings saved';
  saveIndicator.classList.add('saved');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveIndicator.textContent = 'Settings auto-saved';
    saveIndicator.classList.remove('saved');
  }, 2000);
}

// ── Attach config listeners ──────────────────────────────────
[cfgInvoicePrinter, cfgLabelPrinter, cfgCoverId, cfgDelay, cfgPdfPath].forEach(el => {
  el.addEventListener('change', saveConfig);
  if (el.tagName === 'INPUT') el.addEventListener('input', saveConfig);
});
cfgScanPerOrder.addEventListener('change', saveConfig);
cfgPauseOnSku.addEventListener('change', saveConfig);
cfgPdfGroupSku.addEventListener('change', saveConfig);
btnRefresh.addEventListener('click', fetchPrinters);



// ── Init ─────────────────────────────────────────────────────
checkAuth();
