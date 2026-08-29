// ─────────────────────────────────────────────────────────────
//  background.js  –  Service Worker (Manifest V3)
//  Orchestrates the full Myntra order-processing pipeline:
//
//  Step 1 → Generate Picklist
//  Step 2 → Fetch Picklist Status / Details
//  Step 3 → QC Pass
//  Step 4 → Mark Ready-to-Ship
//  Step 5 → Print Invoice & Shipping Label
// ─────────────────────────────────────────────────────────────
'use strict';


// ── State ─────────────────────────────────────────────────────
let automationState = {
  running: false,
  tabId: null,
};

// ── Next SKU pause/resume mechanism ──────────────────────
let nextSkuResolver = null;
function waitForNextSku() {
  return new Promise(resolve => {
    nextSkuResolver = resolve;
  });
}

// ── Cover ID scan pause/resume mechanism ─────────────────
let coverIdResolver = null;
function waitForCoverId() {
  return new Promise(resolve => {
    coverIdResolver = resolve;
  });
}

// ── Communication helpers ─────────────────────────────────────
// Broadcasts to BOTH the popup (if open) AND the content script tab
function broadcast(msg) {
  // → popup
  chrome.runtime.sendMessage(msg).catch(() => { });
  // → content script FAB panel (if a Myntra tab is active)
  if (automationState.tabId) {
    chrome.tabs.sendMessage(automationState.tabId, msg).catch(() => { });
  }
}
function log(text, level = 'info') {
  broadcast({ type: 'LOG', text, level });
}
function stepActive(n) { broadcast({ type: 'STEP_ACTIVE', step: n }); }
function stepDone(n) { broadcast({ type: 'STEP_DONE', step: n }); }
function stepFailed(n) { broadcast({ type: 'STEP_FAILED', step: n }); }
function done() { broadcast({ type: 'DONE' }); }
function error(text) { broadcast({ type: 'ERROR', text }); }

// ── Delay ─────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const API_BASE_URL = 'https://mtool-authapi.onrender.com';

// ── License Validation ────────────────────────────────────────
async function validateLicense() {
  const result = await chrome.storage.local.get('moaAuth');
  const auth = result.moaAuth;

  const user = auth?.user || {
    name: 'Free User',
    email: '',
    planType: 'free',
    isExpired: false,
    isActive: true,
    daysRemaining: 99999,
  };

  return { valid: true, user };
}

// ── Monthly Order Counter (local + server report) ─────────────
async function incrementOrderCount() {
  // Local tracking
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const result = await chrome.storage.local.get('moaOrderCount');
  const counter = result.moaOrderCount || {};
  if (counter.month !== monthKey) {
    counter.month = monthKey;
    counter.count = 0;
  }
  counter.count = (counter.count || 0) + 1;
  await chrome.storage.local.set({ moaOrderCount: counter });

  // Report to server (fire-and-forget)
  try {
    const authResult = await chrome.storage.local.get('moaAuth');
    const auth = authResult.moaAuth;
    if (auth?.accessToken) {
      fetch(`${API_BASE_URL}/api/moa/report-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${auth.accessToken}`,
        },
      }).catch(() => { }); // Ignore errors — non-critical
    }
  } catch { }

  return counter.count;
}

// ── Service Worker Keep-Alive ───────────────────────────────
// MV3 service workers go idle after ~30s. We use chrome.alarms
// to keep the worker alive during active automation.
function startKeepAlive() {
  chrome.alarms.create('moa-keep-alive', { periodInMinutes: 0.4 }); // ~24s
}
function stopKeepAlive() {
  chrome.alarms.clear('moa-keep-alive');
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'moa-keep-alive' && automationState.running) {
    // Intentional no-op — just waking the worker is enough
  }
});

// ── Proxy API calls through the content script ───────────────
// The content script runs in the page's cookie/auth context so
// every fetch() it makes automatically includes session cookies.
async function apiCall(tabId, method, url, body = null, extraHeaders = {}, skipBody = false) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'FETCH_API',
        payload: { method, url, body, extraHeaders, skipBody }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response) {
          return reject(new Error('No response from content script. Is the Myntra tab open?'));
        }
        if (!response.success) {
          return reject(new Error(response.error || 'Content script fetch failed'));
        }
        const r = response.result;
        if (!r.ok) {
          return reject(new Error(`HTTP ${r.status} from ${url}`));
        }
        resolve(r.data);
      }
    );
  });
}

// ── Get auth info from content script ────────────────────────
async function getAuthInfo(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: 'GET_AUTH_INFO' }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.success) return reject(new Error('Cannot get auth info'));
      resolve(response.authInfo);
    });
  });
}

// ── Ensure content script is injected ────────────────────────
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (_) {
    // Already injected – fine
  }
}

// ── Default configuration (overridden by dynamic discovery + user settings) ──
const CONFIG = {
  storePartnerIds: null,   // Discovered dynamically from Myntra boot API
  warehouseId: null,       // Discovered dynamically from Myntra boot API
  sellerId: null,          // Discovered dynamically from Myntra boot API
  quantity: '100',
  orderType: 'BOTH',
  priority: false,
  invoicePrinter: 'TSC DA310',
  labelPrinter: 'TSC DA310',
  defaultCoverId: 'myntra123',
  askCoverIdPerOrder: false,
};

// Common Myntra-specific request headers
const MYNTRA_HEADERS = {
  'x-myntra-app-name': 'mdirect',
  'x-myntra-client-id': 'mdirect',
  'x-myntra-mdirect-service': 'genie.orders.generatePicklist',
  'x-requested-with': 'XMLHttpRequest',
  'origin': 'https://mdirect.myntrainfo.com',
  'referer': 'https://mdirect.myntrainfo.com/',
};

// ── QZ Tray certificate and signing key (defined once, passed to injected scripts) ──
const QZ_CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIDaDCCAlCgAwIBAgIBAjANBgkqhkiG9w0BAQsFADBKMSIwIAYDVQQDExlNeW50\ncmEgQXV0b21hdGlvbiBSb290IENBMQswCQYDVQQGEwJJTjEXMBUGA1UEChMOTXlu\ndHJhIFNlbGxlcnMwHhcNMjYwNjA2MTE1MDMwWhcNMzYwNjA2MTE1MDMwWjBHMR8w\nHQYDVQQDExZtZGlyZWN0Lm15bnRyYWluZm8uY29tMQswCQYDVQQGEwJJTjEXMBUG\nA1UEChMOTXludHJhIFNlbGxlcnMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK\nAoIBAQCgP4OcxDt53H6itRRdj3bUL+ZxohASl4L+n6t5J1abluJ7pLXt8HioqOX1\nC64Ih8YdMdcFViCtkVbczLWx9ZojyYEfXANriyYXp+j+NEhkYpNaQPxudkViy0U2\nK6CSYDZZ4H7Zf0FqAyU5MomNTs8pjv29c/iXNp3Uu32EBz54DL739+OezBuWNVEI\n4Y8y8ZbMd1nWb5QzMDYyCBzo9BMuIHYUIr61EgwDwq8JL96WGRSIHG/NS78MPx80\nmDK+2S8EX1iz7eiIbMsaaBPAPSOwCrh4Ssy2CYW9sZzNcv5iMqsuBRZh7bapkP9k\npVTvKvAqMyF+OZ4AuZi7p9PvxpldAgMBAAGjXDBaMAkGA1UdEwQCMAAwCwYDVR0P\nBAQDAgTwMB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAhBgNVHREEGjAY\nghZtZGlyZWN0Lm15bnRyYWluZm8uY29tMA0GCSqGSIb3DQEBCwUAA4IBAQBHjG9k\nrsTXj6NII7G9xq/z9Mp4HnWvAyQ0uE579yDi+ujh7KBSscnONdBLyC9Rkd67wiBR\nNXP3uqrTPHBmrfrP2XVlDq+5zo82KqHtHMG30clJ5wbRzBx1y0Vq1Eq//IfUdI8k\n6J3Vo+VGD5d8x8hB9UWUtMfdJOUW0RB6sIzEkMOY25H1GlEwHnfU21Y8cfqeXAsk\n5WW4kZm+a/h+r4qo3u+rReZ40qiAkOOr13tGvhVsKKbmczPukFVNxYurmuWMcT0l\nc3V1osnXxpOvzP4r9+AfbxrDK4lCLREo/x59Md8y6QXoBgC4Y7xZkiuF1luVuojk\njLSrM2vy6q0FKEQ5\n-----END CERTIFICATE-----\n";

const QZ_PRIVATE_KEY_B64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCgP4OcxDt53H6itRRdj3bUL+ZxohASl4L+n6t5J1abluJ7pLXt8HioqOX1C64Ih8YdMdcFViCtkVbczLWx9ZojyYEfXANriyYXp+j+NEhkYpNaQPxudkViy0U2K6CSYDZZ4H7Zf0FqAyU5MomNTs8pjv29c/iXNp3Uu32EBz54DL739+OezBuWNVEI4Y8y8ZbMd1nWb5QzMDYyCBzo9BMuIHYUIr61EgwDwq8JL96WGRSIHG/NS78MPx80mDK+2S8EX1iz7eiIbMsaaBPAPSOwCrh4Ssy2CYW9sZzNcv5iMqsuBRZh7bapkP9kpVTvKvAqMyF+OZ4AuZi7p9PvxpldAgMBAAECggEADT6CmavMQJudKcRujPcE+q+Ey8J5spesH3BB408BhPV4/YAU+zfjOQlQjCqtdQ4HrTUH0OyX4dB/zdrrb2xdk3Sdg+J+c955xP2/L3dRvl45UH3LfzOuM2aab0o2yLJD+7Smt0IhvWnKI0qOfMvVKlmjlgtmMdU1QTZHvug8XP6LMC7E0EgpfTcpU2jEwK/YFNoc7+BP88s12nXVD8y5egKZsITXW+RHhZKfpO9aD0UOAAmTzBH2XLLaNS8GQ0CbOdDuw0J9bhya+IKUwuSPLC+QiAYWH+HvtZWb478/R7HmlmFPGnpnGP74bbqaAYoevQ1FH6lBYJi0Rx/vZdOgHwKBgQDRi3YDfk31Zv3zk6mFiP32h1jn3D9+uJq7oLF9Vy7icnAZHLYDAg8ZDs6oIXKU8GeoCRTYj1VEz//j/4ThPFY1LVLS8eHe/4uqXYhI4Z23nWyIo8RKgioAJe6ceeuH+M1nXV2yQR+CuH45jN82Hwn+w8u9gNzxeEDTwM0xLqEG0wKBgQDDxkMEEWrCLoYab4TtTuUah7QK5bACYSwfY6xtoTxBpGiDkyGXP5zFQrGo01JtItEBoVbDnXIGsX8Qetkp8Aay7PKkbC6Ny5zydjy46THK5PNePP6k5SdbdPYL6Zs3mhdu273vtLDrfggwgYqIxRxGQKn50Q8E3+eJRWzLpfIhDwKBgQCAyg6GpyKTKfH7u0393Oz6kMV7/EqqQBwaJfHw75zJYTy0sojL4IAXDprFi4k5MWkERlChqbbmzFCieXHaXZM+q9S0AiapQLc+xq303XZqXD9Q3BbRFJ9r5+R4GBdDQxA7746e+Je9aFdsV8D5KqqiAwU+O+2QHDD79QwoplgiMQKBgFt+OKuaCC6f14RbQeA10tRHP1koZs115Ez3JApIJAT5dO6owDYTQIzf0m938zmV39/HKulYl4WRRjTJdNwolLjiC7PT6x3RXpPhthckxGRyA1qzXr5paa9QRfzjO+sMVI82mtl/tH8Z83HX2Ip6s/ARIF7j2QUKLwb0Lxgtga75AoGAQzT7AxHLOsP5yzykA5HYrjXP8B0BbDwr4DT4wleqgBLzyfioI0x08jEFxooRQeOZ/M0Nx5qGMKOrzT8X81NNlj5arEpO4XOJf5Eokic9AfLwvsS5A33TufLlRx6tCBnOgMJ/AO9Kmpy4cXKJbremdcTR8/lWR3v4gv0s4UpPuTU=";

// Shared QZ Tray security setup function (injected into page context)
// This function is serialized and passed to chrome.scripting.executeScript
function _qzSecuritySetup(qzCert, pkcs8Base64) {
  if (typeof qz === 'undefined') return;
  if (qz.security && qz.security.setCertificatePromise) {
    qz.security.setCertificatePromise(function (resolve) { resolve(qzCert); });
  }
  if (qz.security && qz.security.setSignatureAlgorithm) {
    qz.security.setSignatureAlgorithm('SHA512');
  }
  if (qz.security && qz.security.setSignaturePromise) {
    qz.security.setSignaturePromise(function (toSign) {
      return function (resolve, reject) {
        try {
          const bin = window.atob(pkcs8Base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          window.crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['sign'])
            .then(pk => window.crypto.subtle.sign('RSASSA-PKCS1-v1_5', pk, new TextEncoder().encode(toSign)))
            .then(sig => { let b = ''; new Uint8Array(sig).forEach(c => b += String.fromCharCode(c)); resolve(window.btoa(b)); })
            .catch(reject);
        } catch (e) { reject(e); }
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────
//  MAIN AUTOMATION PIPELINE
// ─────────────────────────────────────────────────────────────
async function runAutomation({ tabId, delay: stepDelay, quantity, orderType, existingPicklistBarcode }) {
  // ── License Gate ─────────────────────────────────────────────
  log('✅ Free Unlimited Access Enabled', 'success');

  // Load saved config from chrome.storage.local (set by popup)
  const stored = await chrome.storage.local.get('moaConfig');
  const savedConfig = stored.moaConfig || {};

  const invoicePrinter = savedConfig.invoicePrinter || CONFIG.invoicePrinter;
  const labelPrinter = savedConfig.labelPrinter || CONFIG.labelPrinter;
  const defaultCoverId = savedConfig.defaultCoverId || CONFIG.defaultCoverId;
  const askCoverIdPerOrder = savedConfig.askCoverIdPerOrder ?? CONFIG.askCoverIdPerOrder;
  stepDelay = savedConfig.stepDelay || stepDelay || 1500;
  const pauseOnSkuChange = savedConfig.pauseOnSkuChange ?? true;
  const pdfSavePath = savedConfig.pdfSavePath || 'MyntraOrders';
  const pdfGroupBySku = savedConfig.pdfGroupBySku ?? true;

  quantity = quantity || CONFIG.quantity;
  orderType = orderType || CONFIG.orderType;
  existingPicklistBarcode = (existingPicklistBarcode || '').trim();
  automationState.running = true;
  automationState.tabId = tabId;

  // ── Summary tracking ────────────────────────────────────────
  const summaryData = {
    startTime: Date.now(),
    endTime: null,
    picklistBarcode: '',
    totalOrders: 0,
    totalSkus: 0,
    singleItemOrders: 0,
    multiItemOrders: 0,
    skuBreakdown: [], // { skuCode, sellerSkuCode, ordersProcessed }
  };

  // Check if printer is PDF auto-save mode (supports macOS, Windows, Linux)
  function isPdfPrinter(printerName) {
    if (!printerName) return false;
    const p = printerName.toLowerCase();
    return p.includes('pdf') || p.includes('save as') || p.includes('save to') || p.includes('print to file') || p.includes('preview');
  }

  const invoiceIsPdf = isPdfPrinter(invoicePrinter);
  const labelIsPdf = isPdfPrinter(labelPrinter);
  if (invoiceIsPdf) log(`📁 Invoice printer is PDF — will auto-save to Downloads/${pdfSavePath}/`, 'info');
  if (labelIsPdf) log(`📁 Label printer is PDF — will auto-save to Downloads/${pdfSavePath}/`, 'info');

  log(`⚙ Config: Invoice→"${invoicePrinter}" | Label→"${labelPrinter}" | CoverID→"${defaultCoverId}" | ScanPerOrder→${askCoverIdPerOrder} | PauseOnSKU→${pauseOnSkuChange}`, 'info');

  try {
    startKeepAlive();
    // Make sure content script is alive in the target tab
    await ensureContentScript(tabId);
    log('🔗 Content script ready.', 'info');

    // ── Resolve effective config (dynamic from boot API → static fallback) ─
    log('🔍 Resolving dynamic config from boot API…', 'info');

    let effectiveConfig = { ...CONFIG };

    await new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { action: 'GET_DYNAMIC_CONFIG' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.success) {
          log('⚠ Could not get dynamic config; using static CONFIG values.', 'warning');
          return resolve();
        }

        const dyn = resp.config;

        if (dyn.storePartnerIds) {
          effectiveConfig.storePartnerIds = dyn.storePartnerIds;
          log(`✅ storePartnerIds → [${dyn.storePartnerIds}] (from boot API)`, 'success');
        } else if (!effectiveConfig.storePartnerIds) {
          log('⚠ storePartnerIds not discovered — will fail if not available', 'warning');
        }

        if (dyn.warehouseId) {
          effectiveConfig.warehouseId = dyn.warehouseId;
          log(`✅ warehouseId → ${dyn.warehouseId} (from boot API)`, 'success');
        } else if (!effectiveConfig.warehouseId) {
          log('⚠ warehouseId not discovered — will fail if not available', 'warning');
        }

        if (dyn.sellerId) {
          effectiveConfig.sellerId = dyn.sellerId;
          log(`✅ sellerId → ${dyn.sellerId} (from boot API)`, 'success');
        } else if (!effectiveConfig.sellerId) {
          log('⚠ sellerId not discovered — will fail if not available', 'warning');
        }

        if (dyn.discoveredFrom) {
          log(`  📡 Discovered from: ${dyn.discoveredFrom.replace('https://partnersapi.myntrainfo.com', '')}`, 'info');
        }

        resolve();
      });
    });

    if (!effectiveConfig.storePartnerIds || !effectiveConfig.warehouseId || !effectiveConfig.sellerId) {
      throw new Error(
        'Missing Warehouse ID or Seller ID. Please navigate to the "Orders" or "Pending Orders" tab in Myntra so the extension can detect your account details, then try again.'
      );
    }

    // Grab user login from session (best-effort)

    let userLogin = '';
    try {
      const authInfo = await getAuthInfo(tabId);
      userLogin = authInfo.userLogin || '';
      if (userLogin) log(`👤 Detected userLogin: ${userLogin}`, 'info');
      else log('⚠ userLogin not found in session; payload will omit it.', 'warning');
    } catch (e) {
      log(`⚠ Auth info error: ${e.message}`, 'warning');
    }

    // ── Determine picklist barcode ─────────────────────────────
    // If user provided an existing picklist barcode, skip Step 1 + 1b entirely.
    let picklistBarcode;

    if (existingPicklistBarcode) {
      // ── RESUME MODE: Use existing picklist ──────────────────
      picklistBarcode = existingPicklistBarcode;
      log(`📋 Using existing picklist barcode: ${picklistBarcode}`, 'step');
      log(`⏩ Skipping Step 1 (Generate Picklist) — already generated.`, 'info');
      stepDone(1);
    } else {
      // ── STEP 1: Generate Picklist ─────────────────────────────
      stepActive(1);
      log(`📋 Step 1 → Generating picklist for ${quantity} ${orderType.toLowerCase()} order(s)…`, 'step');

      const picklistUrl = 'https://partnersapi.myntrainfo.com/api/mdirect/orders/generatePicklist';
      const picklistBody = {
        pickListCreationRequest: {
          quantity: quantity,
          storePartnerIds: effectiveConfig.storePartnerIds,
          orderType: orderType,
          priority: effectiveConfig.priority,
        },
        warehouseId: effectiveConfig.warehouseId,
      };

      log(`  → PUT ${picklistUrl}`, 'info');
      log(`  → Body: ${JSON.stringify(picklistBody)}`, 'info');

      let picklistData;
      try {
        picklistData = await apiCall(tabId, 'PUT', picklistUrl, picklistBody, MYNTRA_HEADERS);
      } catch (e) {
        stepFailed(1);
        throw new Error(`Step 1 (Generate Picklist) failed: ${e.message}`);
      }

      const picklistResp = picklistData?.orderPickListResponse;
      if (!picklistResp) {
        stepFailed(1);
        throw new Error(`Step 1: Unexpected response – ${JSON.stringify(picklistData).slice(0, 200)}`);
      }

      const statusCode = picklistResp?.status?.statusCode;
      if (statusCode !== 3) {
        stepFailed(1);
        throw new Error(`Step 1 failed: ${picklistResp?.status?.statusMessage || 'Unknown error'} (code ${statusCode})`);
      }

      const picklistId = picklistResp.data?.orderPicklist?.id;
      picklistBarcode = picklistResp.data?.orderPicklist?.barcode;
      if (!picklistBarcode || !picklistId) {
        stepFailed(1);
        throw new Error('Step 1: Could not extract barcode/id from response');
      }

      log(`✅ Picklist created → id: ${picklistId}, barcode: ${picklistBarcode}`, 'success');
      stepDone(1);
    }

    await delay(stepDelay);

    // ── STEP 1b: Download & Parse Picklist PDF ─────────────────
    // The downloadPicklist API returns a PDF containing product details:
    // Myntra Sku Code | Seller Sku Code | Product Description | Quantity | Expiry Dates
    // We parse this PDF to extract structured product data.
    if (!existingPicklistBarcode) {
      log('📥 Step 1b → Downloading & parsing picklist PDF…', 'step');
      const downloadUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/downloadPicklist/${picklistBarcode}`;

      let picklistProducts = []; // Will hold parsed product rows from PDF

      try {
        // Get XSRF token for authenticated fetch
        let dlXsrf = '';
        try {
          const authInfo = await getAuthInfo(tabId);
          dlXsrf = authInfo.xsrf || '';
        } catch (_) { }

        const pdfParseResults = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async (downloadUrl, xsrfToken, pdfJsUrl, pdfWorkerUrl) => {

            // ── Load pdf.js library if not already loaded ──
            async function ensurePdfJs() {
              if (typeof pdfjsLib !== 'undefined') return;
              await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = pdfJsUrl;
                script.onload = resolve;
                script.onerror = () => reject(new Error('Failed to load pdf.js'));
                document.head.appendChild(script);
              });
              // Wait for pdfjsLib to be available
              for (let i = 0; i < 20; i++) {
                if (typeof pdfjsLib !== 'undefined') break;
                await new Promise(r => setTimeout(r, 200));
              }
              if (typeof pdfjsLib === 'undefined') {
                throw new Error('pdf.js library did not initialize');
              }
              // Set worker source
              pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
            }

            try {
              // Fetch the PDF blob
              const resp = await fetch(downloadUrl, {
                credentials: 'include',
                headers: {
                  'accept': '*/*',
                  'x-myntra-xsrf-token': xsrfToken,
                  'x-myntra-app-name': 'mdirect',
                  'x-myntra-client-id': 'mdirect',
                  'x-myntra-knuth': 'yes',
                  'x-requested-with': 'XMLHttpRequest',
                  'origin': 'https://mdirect.myntrainfo.com',
                  'referer': 'https://mdirect.myntrainfo.com/',
                },
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status} from downloadPicklist`);

              const arrayBuffer = await resp.arrayBuffer();

              // Load pdf.js
              await ensurePdfJs();

              // Parse the PDF
              const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
              const allText = [];

              for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const items = textContent.items.map(item => ({
                  text: item.str.trim(),
                  x: Math.round(item.transform[4]),
                  y: Math.round(item.transform[5]),
                })).filter(item => item.text);
                allText.push(...items);
              }

              // ── Column-based PDF table parser ──────────────────────
              // This handles multi-line wrapped text in cells.
              //
              // Strategy:
              //   1. Find header items containing "Myntra Sku" → get column X boundaries
              //   2. Find "Total Quantity" Y → end boundary
              //   3. Collect all text items in between (the data zone)
              //   4. Assign each item to a column based on X position
              //   5. Detect product row boundaries using Myntra SKU Code pattern
              //      (uppercase letters followed by digits, e.g. MOVRWTCH130740555)
              //   6. Within each row, join multi-line text per column

              // Step 1: Find all header-related text items
              // Header may span 2 lines ("Seller Sku\nCode", "Expiry\nDates")
              // Find the Y zone that contains "Myntra" keyword
              let headerMinY = Infinity, headerMaxY = -Infinity;
              for (const it of allText) {
                if (it.text.includes('Myntra') && it.text.includes('Sku')) {
                  headerMinY = Math.min(headerMinY, it.y);
                  headerMaxY = Math.max(headerMaxY, it.y);
                }
              }

              if (headerMinY === Infinity) {
                const rawText = allText.map(it => it.text).join(' ');
                return { ok: true, products: [], rawText: rawText.slice(0, 500), method: 'no_header' };
              }

              // Expand header zone ±20px to catch wrapped header text like "Seller Sku\nCode"
              headerMinY -= 20;
              headerMaxY += 5;

              // Collect header items to determine column X boundaries
              const headerItems = allText.filter(it => it.y >= headerMinY && it.y <= headerMaxY);

              // Determine 5 column left-X boundaries from header items
              // Known columns: Myntra Sku Code | Seller Sku Code | Product Description | Quantity | Expiry Dates
              // Group header items by X proximity (within 30px = same column)
              const colXGroups = [];
              const sortedHeader = [...headerItems].sort((a, b) => a.x - b.x);
              for (const it of sortedHeader) {
                const existing = colXGroups.find(g => Math.abs(g.x - it.x) < 30);
                if (existing) {
                  existing.x = Math.min(existing.x, it.x); // use leftmost X
                } else {
                  colXGroups.push({ x: it.x });
                }
              }
              colXGroups.sort((a, b) => a.x - b.x);

              // We expect 5 columns
              const colBoundaries = colXGroups.map(g => g.x);

              // Step 2: Find "Total Quantity" Y position (end of data)
              let totalQtyY = -Infinity;
              for (const it of allText) {
                if (it.text.includes('Total') && it.text.includes('Quantity')) {
                  totalQtyY = it.y;
                  break;
                }
              }
              // Also check for items with just "Total"
              if (totalQtyY === -Infinity) {
                for (const it of allText) {
                  if (it.text === 'Total') {
                    totalQtyY = it.y;
                    break;
                  }
                }
              }

              // Step 3: Collect data items (below header, above "Total Quantity")
              // In PDF coords: header has higher Y, data has lower Y, total has even lower Y
              const dataItems = allText.filter(it => {
                if (it.y >= headerMinY) return false;         // above/in header
                if (totalQtyY !== -Infinity && it.y <= totalQtyY) return false; // at/below total
                return true;
              });

              if (dataItems.length === 0) {
                return { ok: true, products: [], rawText: 'No data items found between header and total', method: 'no_data' };
              }

              // Step 4: Assign each data item to a column based on X position
              function getColIndex(x) {
                for (let c = colBoundaries.length - 1; c >= 0; c--) {
                  if (x >= colBoundaries[c] - 15) return c;
                }
                return 0;
              }

              // Step 5: Detect product rows using column 0 (Myntra SKU Code)
              // Pattern: uppercase letters followed by digits, e.g. MOVRWTCH130740555
              const skuPattern = /^[A-Z]{2,}[0-9]{5,}$/;

              // Sort data items by Y descending (top to bottom in PDF)
              dataItems.sort((a, b) => b.y - a.y);

              // Find row start Y positions: items in col 0 matching SKU pattern
              const rowStarts = []; // { y, skuText }
              for (const it of dataItems) {
                const col = getColIndex(it.x);
                if (col === 0 && skuPattern.test(it.text)) {
                  rowStarts.push({ y: it.y, skuText: it.text });
                }
              }

              if (rowStarts.length === 0) {
                // Fallback: try to detect rows by first column items
                const col0Items = dataItems.filter(it => getColIndex(it.x) === 0);
                if (col0Items.length > 0) {
                  // Use first item in col 0 as a row start
                  rowStarts.push({ y: col0Items[0].y, skuText: col0Items[0].text });
                }
              }

              // Step 6: Build products — for each row, collect items per column
              const products = [];
              for (let r = 0; r < rowStarts.length; r++) {
                const rowTopY = rowStarts[r].y + 5; // slight buffer above
                const rowBottomY = r < rowStarts.length - 1
                  ? rowStarts[r + 1].y + 5          // next row start
                  : (totalQtyY !== -Infinity ? totalQtyY : -Infinity);

                // Collect items belonging to this row's Y range
                const rowItems = dataItems.filter(it =>
                  it.y <= rowTopY && it.y > rowBottomY
                );

                // Group by column, sort each column's items by Y (top to bottom)
                const colTexts = new Array(colBoundaries.length).fill('');
                const colItemsByCol = {};
                for (const it of rowItems) {
                  const col = getColIndex(it.x);
                  if (!colItemsByCol[col]) colItemsByCol[col] = [];
                  colItemsByCol[col].push(it);
                }

                for (const col in colItemsByCol) {
                  // Sort by Y descending (top to bottom in PDF) then X
                  colItemsByCol[col].sort((a, b) => b.y - a.y || a.x - b.x);
                  colTexts[col] = colItemsByCol[col].map(it => it.text).join(' ');
                }

                products.push({
                  myntraSkuCode: colTexts[0] || '',
                  sellerSkuCode: colTexts[1] || '',
                  productDescription: colTexts[2] || '',
                  quantity: parseInt(colTexts[3]) || 1,
                  expiryDate: colTexts[4] || 'N/A',
                });
              }

              return { ok: true, products, colCount: colBoundaries.length, method: 'column_based' };
            } catch (err) {
              return { ok: false, error: err.message };
            }
          },
          args: [downloadUrl, dlXsrf, chrome.runtime.getURL('pdfjs/pdf.min.js'), chrome.runtime.getURL('pdfjs/pdf.worker.min.js')],
        });

        const pdfResult = pdfParseResults?.[0]?.result;

        if (pdfResult?.ok && pdfResult.products?.length > 0) {
          picklistProducts = pdfResult.products;
          log(`✅ Picklist PDF parsed → ${picklistProducts.length} product(s) found:`, 'success');
          for (const prod of picklistProducts) {
            log(`   📦 ${prod.myntraSkuCode} | ${prod.sellerSkuCode} | ${prod.productDescription} | Qty: ${prod.quantity}`, 'info');
          }
        } else if (pdfResult?.ok) {
          log(`⚠ PDF parsed but no product rows extracted (method: ${pdfResult.method})`, 'warning');
          if (pdfResult.rawText) {
            log(`  📋 Raw PDF text: ${pdfResult.rawText}`, 'info');
          }
        } else {
          log(`⚠ PDF parse warning: ${pdfResult?.error || 'Unknown error'}`, 'warning');
        }

        log(`✅ downloadPicklist succeeded → picklist INITIATED`, 'success');
      } catch (e) {
        // Non-fatal: log the warning but continue to Step 2
        log(`⚠ downloadPicklist/PDF parse warning (non-fatal): ${e.message}`, 'warning');
      }
    } else {
      log(`⏩ Skipping Step 1b (PDF parse) — using existing picklist.`, 'info');
    }
    await delay(Math.floor(stepDelay / 2));

    // ── STEP 2: Fetch SKU Mapping from Packets API ─────────────
    stepActive(2);
    log(`🔍 Step 2 → Fetching SKU mapping from packets API for barcode: ${picklistBarcode}…`, 'step');

    const packetsUrl = `https://partnersapi.myntrainfo.com/api/mdirect/packets/${picklistBarcode}`;
    const packetsHeaders = {
      'x-myntra-app-name': 'mdirect',
      'x-myntra-client-id': 'mdirect',
      'x-myntra-mdirect-service': 'genie.orders.getPicklist',
      'x-requested-with': 'XMLHttpRequest',
      'origin': 'https://mdirect.myntrainfo.com',
      'referer': 'https://mdirect.myntrainfo.com/',
    };

    let sellarskuMyntrasku = {};
    try {
      const packetsData = await apiCall(tabId, 'GET', packetsUrl, null, packetsHeaders);
      sellarskuMyntrasku = packetsData?.sellarsku_myntrasku || {};

      if (Object.keys(sellarskuMyntrasku).length === 0) {
        stepFailed(2);
        throw new Error('Step 2: No sellarsku_myntrasku mapping found in packets response');
      }

      log(`✅ SKU mapping found → ${Object.keys(sellarskuMyntrasku).length} SKU(s):`, 'success');
      for (const [sellerSku, myntraSku] of Object.entries(sellarskuMyntrasku)) {
        log(`   📦 Seller: ${sellerSku} → Myntra: ${myntraSku}`, 'info');
      }
    } catch (e) {
      if (e.message.startsWith('Step 2:')) throw e;
      stepFailed(2);
      throw new Error(`Step 2 (Packets API) failed: ${e.message}`);
    }

    // Build SKU list from the sellarsku_myntrasku mapping
    const skuList = Object.entries(sellarskuMyntrasku).map(([sellerSkuCode, myntraSkuCode]) => ({
      sellerSkuCode,
      myntraSkuCode,
    }));

    log(`📦 Total SKUs to process: ${skuList.length}`, 'info');
    stepDone(2);
    await delay(stepDelay);

    // ── SKU-by-SKU Processing (Dynamic Packet Discovery) ─────
    // For each SKU, repeatedly call the items API to discover packets
    // one-by-one, process (QC → RTS → Print), and loop until CLOSED.
    const qcUrl = 'https://partnersapi.myntrainfo.com/api/mdirect/packets/items/qcpass';

    // Pre-fetch XSRF token and storePartnerId for printing
    let xsrfToken = '';
    try {
      const authInfo = await getAuthInfo(tabId);
      xsrfToken = authInfo.xsrf || '';
    } catch (_) { }
    const storePartnerId = effectiveConfig.storePartnerIds[0];

    const itemsHeaders = {
      'x-myntra-app-name': 'mdirect',
      'x-myntra-client-id': 'mdirect',
      'x-myntra-mdirect-service': 'genie.orders.getPacketAndStyleDetailsByPicklistAndSku',
      'x-requested-with': 'XMLHttpRequest',
      'origin': 'https://mdirect.myntrainfo.com',
      'referer': 'https://mdirect.myntrainfo.com/',
    };

    // ── STEP 3: Process orders for each SKU ────────────────────
    let globalOrderCounter = 0;
    const targetQuantity = parseInt(quantity, 10) || 1;
    const processedPacketIds = new Set(); // Track processed packets to prevent duplicates
    summaryData.picklistBarcode = picklistBarcode;
    const isResumeMode = !!existingPicklistBarcode;

    for (let skuIdx = 0; skuIdx < skuList.length; skuIdx++) {
      const currentSku = skuList[skuIdx];
      const skuCode = currentSku.myntraSkuCode;
      const sellerSkuCodeFromMapping = currentSku.sellerSkuCode;
      let orderCounter = 0;
      let ordersProcessedForThisSku = 0;

      log(`\n─────────────────────────────────────────`, 'info');
      log(`🔄 SKU ${skuIdx + 1}/${skuList.length}: ${skuCode} (Seller: ${sellerSkuCodeFromMapping})`, 'step');

      // ── Inner loop: process all orders for this SKU until CLOSED ──
      while (true) {
        orderCounter++;
        log(`\n  ── Order #${orderCounter} for ${skuCode} ──`, 'info');

        // Call items API to discover the next packet for this SKU
        const itemsUrl = `https://partnersapi.myntrainfo.com/api/mdirect/packets/${picklistBarcode}/items?skuCode=${encodeURIComponent(skuCode)}&warehouseId=${effectiveConfig.warehouseId}`;

        let itemsData;
        let itemsRetries = 0;
        const MAX_ITEMS_RETRIES = 10;
        while (true) {
          try {
            itemsData = await apiCall(tabId, 'GET', itemsUrl, null, itemsHeaders);
          } catch (e) {
            itemsRetries++;
            if (itemsRetries >= MAX_ITEMS_RETRIES) {
              log(`  ⚠ Items API failed after ${MAX_ITEMS_RETRIES} retries: ${e.message}`, 'warning');
              break;
            }
            const retryDelay = Math.min(3000 * itemsRetries, 15000);
            log(`  ⚠ Items API error (attempt ${itemsRetries}/${MAX_ITEMS_RETRIES}): ${e.message} — retrying in ${retryDelay / 1000}s…`, 'warning');
            await delay(retryDelay);
            continue;
          }

          // Check for transient server error (statusCode 86) — retry with randomized delay
          if (itemsData?.status?.statusCode === 86) {
            itemsRetries++;
            if (itemsRetries >= MAX_ITEMS_RETRIES) {
              log(`  ⚠ Items API stuck on error 86 after ${MAX_ITEMS_RETRIES} retries`, 'warning');
              break;
            }
            // Randomized delay: base 2-5s + progressive backoff, max 15s (to avoid bot detection)
            const baseDelay = 2000 + Math.floor(Math.random() * 3000); // 2-5s random
            const retryDelay = Math.min(baseDelay + (1000 * itemsRetries), 15000);
            log(`  ⚠ Server error (code 86, attempt ${itemsRetries}/${MAX_ITEMS_RETRIES}): "${itemsData.status.statusMessage}" — retrying in ${(retryDelay / 1000).toFixed(1)}s…`, 'warning');
            await delay(retryDelay);
            continue;
          }
          break; // Got a valid (non-86) response
        }
        // If we broke out of retry loop due to max retries, break outer loop too
        if (itemsRetries >= MAX_ITEMS_RETRIES) break;

        // Check if picklist is CLOSED for this SKU (statusCode 85 or other ERROR)
        if (itemsData?.status?.statusCode === 85 || itemsData?.status?.statusType === 'ERROR') {
          log(`  🔒 Picklist CLOSED for SKU ${skuCode}: ${itemsData?.status?.statusMessage || 'No more orders'}`, 'info');
          break;
        }

        // Extract packet info from items API response
        const packetInfo = itemsData?.data?.packetInfo;
        if (!packetInfo) {
          log(`  ⚠ No packetInfo in items response — SKU may be exhausted`, 'warning');
          break;
        }

        const sellerPacketId = packetInfo.id;
        const packetItemsArr = packetInfo.packetItems || [];

        if (!sellerPacketId || packetItemsArr.length === 0) {
          log(`  ⚠ No sellerPacketId or packetItems found — skipping`, 'warning');
          break;
        }

        // ── Duplicate packet guard ──────────────────────────────────
        // If this sellerPacketId was already processed (QC + Print),
        // wait briefly for API to catch up, then retry or skip.
        if (processedPacketIds.has(sellerPacketId)) {
          const MAX_DUPLICATE_RETRIES = 3;
          let dupResolved = false;
          for (let dupRetry = 1; dupRetry <= MAX_DUPLICATE_RETRIES; dupRetry++) {
            const dupDelay = 2000 + Math.floor(Math.random() * 2000); // 2-4s random
            log(`  ⚠ Packet ${sellerPacketId} already processed — waiting ${(dupDelay / 1000).toFixed(1)}s for API to update (attempt ${dupRetry}/${MAX_DUPLICATE_RETRIES})…`, 'warning');
            await delay(dupDelay);
            // Re-call items API to see if a new packet is available
            try {
              const recheckData = await apiCall(tabId, 'GET', itemsUrl, null, itemsHeaders);
              if (recheckData?.status?.statusCode === 85 || recheckData?.status?.statusType === 'ERROR') {
                log(`  🔒 No more orders for SKU ${skuCode} after re-check: ${recheckData?.status?.statusMessage}`, 'info');
                dupResolved = true;
                break;
              }
              const recheckPacketId = recheckData?.data?.packetInfo?.id;
              if (recheckPacketId && !processedPacketIds.has(recheckPacketId)) {
                log(`  ✓ New packet found: ${recheckPacketId} — continuing processing`, 'info');
                // Update packetInfo for the new packet — let the outer code re-run with updated data
                // We break out of dup-retry and let the outer while loop handle it naturally
                dupResolved = false; // not resolved as "done", but as "new packet"
                break;
              }
            } catch (_) { /* ignore and retry */ }
          }
          // If after all retries we still get the same packet, skip this SKU
          if (dupResolved || processedPacketIds.has(sellerPacketId)) {
            // Re-check one final time
            try {
              const finalCheck = await apiCall(tabId, 'GET', itemsUrl, null, itemsHeaders);
              const finalPacketId = finalCheck?.data?.packetInfo?.id;
              if (!finalPacketId || processedPacketIds.has(finalPacketId) || finalCheck?.status?.statusCode === 85) {
                log(`  🔒 SKU ${skuCode} exhausted (duplicate packet keeps returning) — moving to next SKU`, 'info');
                break;
              }
            } catch (_) {
              log(`  🔒 SKU ${skuCode} — API error on final check, moving to next SKU`, 'info');
              break;
            }
          }
          continue; // restart the while loop to re-fetch from items API
        }

        // Extract refIds, portalOrderReleaseId, orderLineId from packetItems
        const refIds = packetItemsArr.map(item => item.refId || item.itemBarcode || String(item.id));
        const portalOrderReleaseId = packetItemsArr[0]?.portalOrderReleaseId;
        const orderLineId = packetItemsArr[0]?.orderLineId;

        log(`  📋 sellerPacketId: ${sellerPacketId}`, 'info');
        log(`  📋 refIds: [${refIds.join(', ')}]`, 'info');
        if (portalOrderReleaseId) log(`  📋 portalOrderReleaseId: ${portalOrderReleaseId}`, 'info');

        // Extract product details from styleInfo for the product card
        const styleInfo = itemsData?.data?.styleInfo;
        const styleIds = Object.keys(styleInfo || {});

        // Build items array with product details for each packet item
        const productItems = packetItemsArr.map(pItem => {
          const sid = String(pItem.styleId);
          const pDetail = styleInfo?.[sid];
          const imgEntry = pDetail?.imageCollection?.imageEntryMap?.default;
          let imgUrl = imgEntry?.resolutions?.['360X480'] || imgEntry?.path || '';
          if (imgUrl.startsWith('http://')) imgUrl = imgUrl.replace('http://', 'https://');
          const option = pDetail?.productOptions?.find(o => o.skuId === pItem.skuId) || pDetail?.productOptions?.[0];
          return {
            imageUrl: imgUrl,
            productName: pDetail?.ProductDisplayName || '',
            myntraSkuCode: option?.skuCode || `SKU-${pItem.skuId}`,
            sellerSkuCode: option?.vendorArticleNumber || sellerSkuCodeFromMapping,
            size: pItem.size || option?.value || '',
            refId: pItem.refId || pItem.itemBarcode || '',
            brand: pDetail?.brandDetails?.name || '',
          };
        });

        // For logging, use first product
        const displayMyntraSkuCode = productItems[0]?.myntraSkuCode || skuCode;
        const displaySellerSkuCode = productItems[0]?.sellerSkuCode || sellerSkuCodeFromMapping;
        const productName = productItems[0]?.productName || '';

        if (productItems.length > 1) {
          log(`  📦 Multi-item packet: ${productItems.length} items`, 'info');
          productItems.forEach((pi, i) => log(`    ${i + 1}. ${pi.productName || pi.myntraSkuCode} (${pi.size})`, 'info'));
        }

        // Show product card in the UI
        broadcast({
          type: 'SHOW_PRODUCT_CARD',
          items: productItems,
          currentSku: skuIdx + 1,
          totalSkus: skuList.length,
          orderNumber: orderCounter,
          totalItems: productItems.length,
        });

        log(`  🖼 Product: ${productName || displayMyntraSkuCode}`, 'info');
        log(`  📦 Myntra: ${displayMyntraSkuCode} | Seller: ${displaySellerSkuCode}`, 'info');

        // ── STEP 3: QC Pass ───────────────────────────────────────
        stepActive(3);
        log(`  ✅ Step 3 → QC Pass: sellerPacketId=${sellerPacketId}`, 'step');

        const qcPacketItems = refIds.map(refId => {
          const item = { refId };
          if (userLogin) item.userLogin = userLogin;
          return item;
        });

        const qcPayload = {
          sellerPacketId: sellerPacketId,
          clientId: 'FulfilmentOrder',
          packetItems: qcPacketItems,
        };

        let effectivePortalOrderReleaseId = portalOrderReleaseId;

        try {
          const qcResp = await apiCall(tabId, 'PUT', qcUrl, qcPayload);
          log(`  ✓ QC Pass response: ${JSON.stringify(qcResp).slice(0, 120)}`, 'success');

          // Extract portalOrderReleaseId from QC Pass response if not already found
          if (!effectivePortalOrderReleaseId) {
            const qcData = qcResp?.data;
            if (Array.isArray(qcData) && qcData.length > 0) {
              const qcPortalId = qcData[0].portalOrderReleaseId;
              if (qcPortalId) {
                effectivePortalOrderReleaseId = qcPortalId;
                log(`  ✓ portalOrderReleaseId from QC → ${qcPortalId}`, 'success');
              }
            }
          }
        } catch (e) {
          stepFailed(3);
          throw new Error(`Step 3 (QC Pass) failed for packet ${sellerPacketId}: ${e.message}`);
        }

        stepDone(3);
        await delay(Math.floor(stepDelay / 2));

        // ── Cover ID resolution ────────────────────────────────────
        let coverId = defaultCoverId;
        if (askCoverIdPerOrder) {
          log(`  📷 Waiting for Cover ID scan…`, 'step');
          broadcast({
            type: 'ASK_COVER_ID',
            sellerPacketId,
            skuCode,
            orderNumber: orderCounter,
            defaultCoverId,
          });
          coverId = await waitForCoverId();
          broadcast({ type: 'HIDE_COVER_ID' });
          log(`  ✓ Cover ID: ${coverId}`, 'success');
        }

        // ── STEP 4: Mark Ready to Ship ────────────────────────────
        stepActive(4);
        log(`  📦 Step 4 → RTS: sellerPacketId=${sellerPacketId}, coverId=${coverId}`, 'step');

        const rtsUrl = `https://partnersapi.myntrainfo.com/api/mdirect/packets/${sellerPacketId}/ready-to-ship`;
        const rtsPayload = {
          sellerPacketId: sellerPacketId,
          packetBarcode: coverId,
          clientId: 'FulfilmentOrder',
          packetItems: refIds.map(refId => ({ refId })),
        };

        try {
          const rtsResp = await apiCall(tabId, 'PUT', rtsUrl, rtsPayload);
          log(`  ✓ RTS response: ${JSON.stringify(rtsResp).slice(0, 120)}`, 'success');
        } catch (e) {
          stepFailed(4);
          throw new Error(`Step 4 (Ready-to-Ship) failed for packet ${sellerPacketId}: ${e.message}`);
        }

        stepDone(4);
        await delay(Math.floor(stepDelay / 2));

        // ── STEP 5: Print Invoice & Label directly via QZ Tray ───────────
        stepActive(5);
        log(`  🖨️  Step 5 → Printing packet ${sellerPacketId}…`, 'step');
        log(`  → Invoice→"${invoicePrinter}" | Label→"${labelPrinter}"`, 'info');

        const sellerOrderId = effectivePortalOrderReleaseId
          ? String(effectivePortalOrderReleaseId)
          : (orderLineId ? String(orderLineId) : refIds[0] || '');
        log(`  → Using sellerOrderId (portalOrderReleaseId): ${sellerOrderId}`, 'info');

        const qp = new URLSearchParams({
          sellerId: effectiveConfig.sellerId,
          campaignEnriched: 'false',
          sellerOrderId: sellerOrderId,
        });

        const invoiceUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/getPacketInvoice/${storePartnerId}?${qp}`;
        const labelUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/getShippingLabelForSellerPacketV2/${storePartnerId}?${qp}`;

        log(`  → sellerPacketId=${sellerPacketId} → detecting QZ Tray + fetching PDFs…`, 'info');

        // Determine which docs need QZ print vs PDF save
        const needQzPrint = !invoiceIsPdf || !labelIsPdf;
        const needPdfSave = invoiceIsPdf || labelIsPdf;

        let printResults;
        try {
          const qzUrl = chrome.runtime.getURL('qz-tray.js');
          // We always fetch both PDFs as base64 from the page context
          // (need page cookies/session). Then handle printing/saving in background.
          printResults = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (invoiceUrl, labelUrl, invoicePrinterArg, labelPrinterArg, xsrfToken, qzCert, qzKey, qzUrl, invoiceIsPdfArg, labelIsPdfArg) => {

              // Fetch a URL and return its content as a base64 string (with retry on 500/504)
              async function fetchBase64(url) {
                const maxRetries = 5;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                  const resp = await fetch(url, {
                    credentials: 'include',
                    headers: {
                      'accept': '*/*',
                      'x-myntra-xsrf-token': xsrfToken,
                      'x-myntra-app-name': 'mdirect',
                      'x-myntra-client-id': 'mdirect',
                      'x-requested-with': 'XMLHttpRequest',
                      'origin': 'https://mdirect.myntrainfo.com',
                      'referer': 'https://mdirect.myntrainfo.com/',
                    },
                  });
                  if (resp.ok) {
                    const blob = await resp.blob();
                    return new Promise((res, rej) => {
                      const reader = new FileReader();
                      reader.onloadend = () => res(reader.result.split(',')[1]);
                      reader.onerror = rej;
                      reader.readAsDataURL(blob);
                    });
                  }
                  if ([500, 502, 503, 504].includes(resp.status) && attempt < maxRetries) {
                    const retryDelay = Math.min(3000 * attempt, 12000);
                    await new Promise(r => setTimeout(r, retryDelay));
                    continue;
                  }
                  throw new Error(`HTTP ${resp.status} from ${url}`);
                }
              }

              // Wait for window.qz or auto-load qz-tray.js
              async function ensureQZ() {
                if (typeof qz !== 'undefined') return;
                for (let i = 0; i < 5; i++) {
                  await new Promise(r => setTimeout(r, 1000));
                  if (typeof qz !== 'undefined') return;
                }
                
                await new Promise((resolve, reject) => {
                  const script = document.createElement('script');
                  script.src = qzUrl;
                  script.onload = resolve;
                  script.onerror = () => reject(new Error('Failed to load qz-tray.js from extension bundle'));
                  document.head.appendChild(script);
                });

                for (let i = 0; i < 10; i++) {
                  await new Promise(r => setTimeout(r, 500));
                  if (typeof qz !== 'undefined') return;
                }
                
                throw new Error('QZ Tray library not available. Make sure QZ Tray is installed and running.');
              }

              // Setup QZ security using passed cert/key
              function setupQzSecurity() {
                if (qz.security && qz.security.setCertificatePromise) {
                  qz.security.setCertificatePromise(function (resolve) { resolve(qzCert); });
                }
                if (qz.security && qz.security.setSignatureAlgorithm) {
                  qz.security.setSignatureAlgorithm('SHA512');
                }
                if (qz.security && qz.security.setSignaturePromise) {
                  qz.security.setSignaturePromise(function (toSign) {
                    return function (resolve, reject) {
                      try {
                        const bin = window.atob(qzKey);
                        const bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                        window.crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['sign'])
                          .then(pk => window.crypto.subtle.sign('RSASSA-PKCS1-v1_5', pk, new TextEncoder().encode(toSign)))
                          .then(sig => { let b = ''; new Uint8Array(sig).forEach(c => b += String.fromCharCode(c)); resolve(window.btoa(b)); })
                          .catch(reject);
                      } catch (e) { reject(e); }
                    };
                  });
                }
              }

              try {
                // Always fetch both PDFs as base64
                const [invoiceB64, labelB64] = await Promise.all([
                  fetchBase64(invoiceUrl),
                  fetchBase64(labelUrl),
                ]);

                // Only use QZ Tray if at least one printer is NOT PDF
                const needQz = !invoiceIsPdfArg || !labelIsPdfArg;
                if (needQz) {
                  await ensureQZ();
                  setupQzSecurity();

                  if (!qz.websocket.isActive()) {
                    await qz.websocket.connect();
                  }

                  // Print only the non-PDF ones via QZ
                  if (!invoiceIsPdfArg) {
                    const invoiceConfig = qz.configs.create(invoicePrinterArg);
                    await qz.print(invoiceConfig, [{ type: 'pixel', format: 'pdf', flavor: 'base64', data: invoiceB64 }]);
                  }
                  if (!labelIsPdfArg) {
                    const labelConfig = qz.configs.create(labelPrinterArg);
                    await qz.print(labelConfig, [{ type: 'pixel', format: 'pdf', flavor: 'base64', data: labelB64 }]);
                  }
                }

                // Return base64 data for PDFs that need saving
                return {
                  ok: true,
                  invoiceB64: invoiceIsPdfArg ? invoiceB64 : null,
                  labelB64: labelIsPdfArg ? labelB64 : null,
                };
              } catch (err) {
                return { ok: false, error: err.message };
              }
            },
            args: [invoiceUrl, labelUrl, invoicePrinter, labelPrinter, xsrfToken, QZ_CERTIFICATE, QZ_PRIVATE_KEY_B64, qzUrl, invoiceIsPdf, labelIsPdf],
          });
        } catch (e) {
          stepFailed(5);
          throw new Error(`Step 5 (executeScript) error: ${e.message}`);
        }

        const printResult = printResults?.[0]?.result;
        if (!printResult?.ok) {
          stepFailed(5);
          throw new Error(`Step 5 (QZ Print) failed: ${printResult?.error || 'No result from page'}`);
        }

        // ── PDF Auto-Save via chrome.downloads ───────────────────
        if (needPdfSave) {
          const safeSellerSku = (displaySellerSkuCode || sellerSkuCodeFromMapping || 'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g, '_');
          const safePacketId = String(sellerPacketId).replace(/[^a-zA-Z0-9_-]/g, '_');

          // Build folder path: with SKU subfolder or flat
          const folderBase = pdfGroupBySku
            ? `${pdfSavePath}/${safeSellerSku}`
            : pdfSavePath;

          if (printResult.invoiceB64) {
            const invoiceFilename = `${folderBase}/Invoice_${safeSellerSku}_Order${orderCounter}_${safePacketId}.pdf`;
            try {
              await chrome.downloads.download({
                url: `data:application/pdf;base64,${printResult.invoiceB64}`,
                filename: invoiceFilename,
                saveAs: false,
                conflictAction: 'uniquify',
              });
              log(`  💾 Invoice saved → ${invoiceFilename}`, 'success');
            } catch (dlErr) {
              log(`  ⚠ Invoice save failed: ${dlErr.message}`, 'warning');
            }
          }

          if (printResult.labelB64) {
            const labelFilename = `${folderBase}/Label_${safeSellerSku}_Order${orderCounter}_${safePacketId}.pdf`;
            try {
              await chrome.downloads.download({
                url: `data:application/pdf;base64,${printResult.labelB64}`,
                filename: labelFilename,
                saveAs: false,
                conflictAction: 'uniquify',
              });
              log(`  💾 Label saved → ${labelFilename}`, 'success');
            } catch (dlErr) {
              log(`  ⚠ Label save failed: ${dlErr.message}`, 'warning');
            }
          }
        }

        log(`  ✅ Invoice→"${invoicePrinter}" | Label→"${labelPrinter}" — ${needPdfSave ? 'saved to PDF!' : 'printing!'}`, 'success');
        stepDone(5);

        processedPacketIds.add(sellerPacketId); // Mark this packet as processed
        ordersProcessedForThisSku++;
        globalOrderCounter++;

        // ── Track summary data ──────────────────────────────────
        summaryData.totalOrders++;
        if (packetItemsArr.length > 1) {
          summaryData.multiItemOrders++;
        } else {
          summaryData.singleItemOrders++;
        }

        await incrementOrderCount(); // Track monthly order usage for subscription
        if (!isResumeMode && globalOrderCounter >= targetQuantity) {
          log(`✅ Reached requested total quantity of ${targetQuantity} order(s). Stopping early.`, 'success');
          break;
        }

        await delay(Math.floor(stepDelay / 2));

      } // end inner while-loop (orders for this SKU)

      log(`✅ SKU ${skuCode} completed — ${ordersProcessedForThisSku} order(s) processed.`, 'success');

      // ── Track per-SKU summary ────────────────────────────────
      summaryData.skuBreakdown.push({
        skuCode: skuCode,
        sellerSkuCode: sellerSkuCodeFromMapping,
        ordersProcessed: ordersProcessedForThisSku,
      });

      if (!isResumeMode && globalOrderCounter >= targetQuantity) {
        break; // break outer loop too
      }

      // After all orders for this SKU are exhausted, ask user to proceed to next SKU
      if (skuIdx < skuList.length - 1) {
        if (ordersProcessedForThisSku === 0) {
          log(`⏩ SKU ${skuCode} has no pending orders — auto-skipping to next.`, 'info');
          continue;
        }

        // Check pauseOnSkuChange config
        if (pauseOnSkuChange) {
          log(`⏳ Waiting for user to proceed to next SKU…`, 'info');
          broadcast({
            type: 'SHOW_NEXT_SKU_BTN',
            nextSkuCode: skuList[skuIdx + 1].myntraSkuCode,
            nextSellerSkuCode: skuList[skuIdx + 1].sellerSkuCode,
            nextSkuIdx: skuIdx + 2,
            totalSkus: skuList.length,
          });
          await waitForNextSku();
          broadcast({ type: 'HIDE_NEXT_SKU_BTN' });
          log(`▶ User confirmed — proceeding to next SKU…`, 'info');
        } else {
          log(`⏩ Auto-proceeding to next SKU (pause disabled)…`, 'info');
          await delay(stepDelay);
        }
      }
    } // end SKU loop

    broadcast({ type: 'HIDE_PRODUCT_CARD' });

    // ── Summary ──────────────────────────────────────────────
    summaryData.endTime = Date.now();
    summaryData.totalSkus = summaryData.skuBreakdown.length;
    const elapsed = Math.round((summaryData.endTime - summaryData.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    summaryData.elapsedFormatted = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    log(`🎉 All ${skuList.length} SKU(s) processed!`, 'success');
    log(`📊 Summary: ${summaryData.totalOrders} orders | ${summaryData.totalSkus} SKUs | Single: ${summaryData.singleItemOrders} | Multi: ${summaryData.multiItemOrders} | Time: ${summaryData.elapsedFormatted}`, 'success');

    // Broadcast summary to UI
    broadcast({ type: 'SHOW_SUMMARY', summary: summaryData });

    // ── Finish ────────────────────────────────────────────────
    log('─────────────────────────────────────────', 'info');
    done();

  } catch (err) {
    log(`Pipeline stopped: ${err.message}`, 'error');
    error(err.message);
  } finally {
    stopKeepAlive();
    automationState.running = false;
  }
}

// ─────────────────────────────────────────────────────────────
//  Message handler
// ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // GET_LICENSE_STATUS – always valid (free version)
  if (msg.action === 'GET_LICENSE_STATUS') {
    sendResponse({ licensed: true, user: { planType: 'free', isActive: true } });
    return true;
  }

  // START_AUTOMATION – can come from popup OR content script FAB
  if (msg.action === 'START_AUTOMATION') {
    if (automationState.running) {
      error('Automation is already running.');
      sendResponse({ started: false, reason: 'already_running' });
      return true;
    }

    // If tabId not provided (called from content script FAB),
    // use the sender's tab ID
    const tabId = msg.tabId || sender?.tab?.id;
    if (!tabId) {
      error('Could not determine Myntra tab ID. Please try from the toolbar popup.');
      sendResponse({ started: false, reason: 'no_tab_id' });
      return true;
    }

    // Store the source tab so broadcast() can relay messages to it
    automationState.tabId = tabId;

    runAutomation({
      tabId,
      delay: msg.delay || 1500,
      quantity: msg.quantity || CONFIG.quantity,
      orderType: msg.orderType || CONFIG.orderType,
      existingPicklistBarcode: msg.existingPicklistBarcode || '',
    });
    sendResponse({ started: true });
    return true;
  }

  // GET_CURRENT_TAB – called by content script FAB to get its own tab ID
  if (msg.action === 'GET_CURRENT_TAB') {
    const tabId = sender?.tab?.id;
    sendResponse({ tabId });
    return true;
  }

  if (msg.action === 'NEXT_SKU_CONFIRMED') {
    if (nextSkuResolver) {
      nextSkuResolver();
      nextSkuResolver = null;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'COVER_ID_RESPONSE') {
    if (coverIdResolver) {
      coverIdResolver(msg.coverId || 'myntra123');
      coverIdResolver = null;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'RESET') {
    stopKeepAlive();
    automationState.running = false;
    sendResponse({ reset: true });
    return true;
  }

  // GET_PRINTERS – Fetch available printers from QZ Tray via Myntra tab
  if (msg.action === 'GET_PRINTERS') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: 'https://mdirect.myntrainfo.com/*' });
        if (!tabs.length) {
          sendResponse({ success: false, error: 'No Myntra tab found. Open mdirect.myntrainfo.com first.' });
          return;
        }
        const tabId = tabs[0].id;
        try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch (_) { }

        const qzUrl = chrome.runtime.getURL('qz-tray.js');
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async (qzCert, qzKey, qzUrl) => {
            async function ensureQZ() {
              if (typeof qz !== 'undefined') return;
              for (let i = 0; i < 5; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (typeof qz !== 'undefined') return;
              }
              
              await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = qzUrl;
                s.onload = resolve;
                s.onerror = () => reject(new Error('Failed to load bundled qz-tray.js'));
                document.head.appendChild(s);
              });
              
              for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (typeof qz !== 'undefined') return;
              }
              
              throw new Error('QZ Tray library not available. Make sure QZ Tray is installed and running.');
            }

            try {
              await ensureQZ();

              // Setup QZ security using passed cert/key
              if (qz.security && qz.security.setCertificatePromise) {
                qz.security.setCertificatePromise(function (resolve) { resolve(qzCert); });
              }
              if (qz.security && qz.security.setSignatureAlgorithm) {
                qz.security.setSignatureAlgorithm('SHA512');
              }
              if (qz.security && qz.security.setSignaturePromise) {
                qz.security.setSignaturePromise(function (toSign) {
                  return function (resolve, reject) {
                    try {
                      const bin = window.atob(qzKey);
                      const bytes = new Uint8Array(bin.length);
                      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                      window.crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['sign'])
                        .then(pk => window.crypto.subtle.sign('RSASSA-PKCS1-v1_5', pk, new TextEncoder().encode(toSign)))
                        .then(sig => { let b = ''; new Uint8Array(sig).forEach(c => b += String.fromCharCode(c)); resolve(window.btoa(b)); })
                        .catch(reject);
                    } catch (e) { reject(e); }
                  };
                });
              }

              if (!qz.websocket.isActive()) {
                await qz.websocket.connect();
              }

              const printers = await qz.printers.find();
              return { ok: true, printers };
            } catch (err) {
              return { ok: false, error: err.message };
            }
          },
          args: [QZ_CERTIFICATE, QZ_PRIVATE_KEY_B64, qzUrl],
        });

        const result = results?.[0]?.result;
        if (result?.ok) {
          sendResponse({ success: true, printers: result.printers });
        } else {
          sendResponse({ success: false, error: result?.error || 'Unknown error' });
        }
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // async response
  }
});

