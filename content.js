// ─────────────────────────────────────────────────────────────
//  content.js  –  Injected into https://mdirect.myntrainfo.com/*
//  Responsibilities:
//    1. Dynamically discover storePartnerIds / warehouseId / sellerId
//       by intercepting the /api/boot/mdirect API response
//    2. Inject a floating "Start Automation" button on the page
//    3. Capture auth headers / cookies from the live page session
//    4. Execute authenticated fetch() calls on behalf of background.js
//    5. Show a live progress panel on the page itself
// ─────────────────────────────────────────────────────────────

// ── § 1  Dynamic Config Discovery ────────────────────────────
//  Runs ONCE (guarded by __moaDynConfig) even across re-injections.
//  Hooks both fetch() and XMLHttpRequest so we capture the boot API
//  response whether it fires before or after the extension loads.
// ─────────────────────────────────────────────────────────────
if (!window.__moaDynConfig) {
  window.__moaDynConfig = {
    storePartnerIds: null,
    warehouseId: null,
    sellerId: null,
    discoveredFrom: null,   // which API URL populated the config
  };

  // ── Parse a JSON response and deeply absorb relevant fields ─
  function _moaParseResponse(url, json) {
    if (!json || typeof json !== 'object') return;

    function searchDeep(obj) {
      if (!obj || typeof obj !== 'object') return;

      _moaAbsorb(obj, url);

      // If we found everything, stop searching
      const c = window.__moaDynConfig;
      if (c.storePartnerIds && c.warehouseId && c.sellerId) return;

      // Recursive scan
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            searchDeep(obj[key]);
          }
        }
      }
    }

    searchDeep(json);
  }

  // ── Absorb config values from a flat object ────────────────
  function _moaAbsorb(obj, url) {
    const c = window.__moaDynConfig;

    // storePartnerIds — prefer storeMapping[].newId (from boot API)
    if (!c.storePartnerIds) {
      // 1) Check storeMapping array first (boot API structure)
      if (Array.isArray(obj.storeMapping) && obj.storeMapping.length) {
        const myntraStore = obj.storeMapping.find(s => s.name === 'myntra.com') || obj.storeMapping[0];
        const newId = myntraStore.newId ?? myntraStore.id;
        if (newId != null && !isNaN(parseInt(newId, 10)) && parseInt(newId, 10) !== -1) {
          c.storePartnerIds = [parseInt(newId, 10)];
          c.discoveredFrom = url;
        }
      }
      // 2) Fallback: storePartnerIds / partnerIds arrays
      if (!c.storePartnerIds) {
        const arrVal = obj.storePartnerIds || obj.partnerIds;
        const sglVal = obj.storePartnerId || obj.partnerId;
        if (Array.isArray(arrVal) && arrVal.length) {
          // Filter out -1 (wildcard/placeholder in config, not a real ID)
          const filtered = arrVal.map(Number).filter(v => v !== -1);
          if (filtered.length) {
            c.storePartnerIds = filtered;
            c.discoveredFrom = url;
          }
        } else if (sglVal != null && !isNaN(parseInt(sglVal, 10)) && parseInt(sglVal, 10) !== -1) {
          c.storePartnerIds = [parseInt(sglVal, 10)];
          c.discoveredFrom = url;
        }
      }
    }

    // warehouseId
    if (!c.warehouseId) {
      const wh = obj.warehouseId ?? obj.whId ?? obj.warehouseID;
      if (wh != null && !isNaN(parseInt(wh, 10))) {
        c.warehouseId = parseInt(wh, 10);
        c.discoveredFrom = url;
      }
    }

    // sellerId
    if (!c.sellerId) {
      const sid = obj.sellerId ?? obj.sellerPartnerId ?? obj.sellerID ?? obj.ownerId;
      if (sid != null) {
        c.sellerId = String(sid);
        c.discoveredFrom = url;
      }
    }
  }

  // ── Listen for messages from MAIN world ──────────────────────
  window.addEventListener('message', (event) => {
    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.source !== 'moa-hook') return;

    if (event.data.type === 'API_JSON') {
      _moaParseResponse(event.data.url, event.data.json);
    }
  });

  // ── Inject Hooks into MAIN world ─────────────────────────────
  // content.js runs in ISOLATED world. To intercept the page's actual API calls,
  // we must inject the hooks directly into the page's DOM (MAIN world).
  const hookScript = document.createElement('script');
  hookScript.src = chrome.runtime.getURL('hook.js');
  (document.head || document.documentElement).appendChild(hookScript);
  // We leave it in the DOM because it relies on src loading asynchronously

  // ✅ No extra boot API call here.
  //    The fetch hook above clones the response of the page's OWN
  //    /api/boot/mdirect call automatically (runs at document_start,
  //    so the hook is in place before the page fires that request).

}

// ── § 2  UI Injection (deferred until DOM is ready) ─────────
//  content_start runs at document_start (before DOMContentLoaded),
//  so we must wait for the DOM before touching document.body.
function _moaInitUI() {
  'use strict';

  // Prevent double-injection of UI
  if (window.__myntraAutomationInjected) return;
  window.__myntraAutomationInjected = true;

  // HTML escape utility to prevent XSS
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }


  // ─── Inject Floating UI ──────────────────────────────────────
  const STYLES = `
    /* ── Neubrutalist Floating Panel ── */
    #moa-panel {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 75vw;
      max-width: 1000px;
      max-height: 85vh;
      overflow: hidden;
      background: #FFFDF6;
      border: 3.5px solid #000000;
      border-radius: 12px;
      box-shadow: 8px 8px 0px #000000;
      display: none;
      flex-direction: column;
      animation: moaSlideUp 0.25s ease;
      z-index: 2147483647;
      font-family: system-ui, -apple-system, sans-serif;
      color: #000000;
    }
    #moa-panel.open { display: flex; }

    #moa-panel-body {
      display: grid;
      grid-template-columns: 280px 1fr;
      overflow-y: auto;
      flex: 1;
      background: #FFFDF6;
    }
    .moa-col-left {
      display: flex;
      flex-direction: column;
      border-right: 2.5px solid #000000;
      background: #FAF8F0;
    }
    .moa-col-right {
      display: flex;
      flex-direction: column;
      padding: 12px;
      background: #FFFDF6;
    }
    @media (max-width: 850px) {
      #moa-panel { width: 90vw; overflow-y: auto; }
      #moa-panel-body {
        display: flex;
        flex-direction: column;
        overflow-y: visible;
      }
      .moa-col-left { border-right: none; border-bottom: 2.5px solid #000000; }
      .moa-col-right { padding: 10px 0; }
    }

    #moa-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(2px);
      z-index: 2147483646;
      display: none;
    }
    #moa-backdrop.open { display: block; }

    @keyframes moaSlideUp {
      from { opacity: 0; transform: translate(-50%, calc(-50% + 20px)) scale(0.97); }
      to   { opacity: 1; transform: translate(-50%, -50%); }
    }

    /* Panel Header */
    #moa-panel-header {
      background: #FFDE59;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 3px solid #000000;
    }
    #moa-panel-header .moa-logo {
      width: 34px; height: 34px;
      background: #FF3F6C;
      border: 2px solid #000000;
      box-shadow: 2.5px 2.5px 0px #000000;
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; font-weight: 900; color: #FFFFFF;
      font-family: system-ui, -apple-system, sans-serif;
      flex-shrink: 0;
    }
    #moa-panel-header .moa-title { color: #000000; font-size: 14px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.5px; }
    #moa-panel-header .moa-sub   { color: #222222; font-size: 11px; font-weight: 700; margin-top: 1px; }
    #moa-close {
      margin-left: auto;
      background: #FFFFFF; border: 2px solid #000000; cursor: pointer;
      color: #000000; font-size: 16px; font-weight: 900; line-height: 1;
      padding: 4px 8px; border-radius: 6px;
      box-shadow: 2px 2px 0px #000000;
      transition: all 0.15s;
    }
    #moa-close:hover { background: #FF3F6C; color: #FFFFFF; transform: translate(-1px, -1px); box-shadow: 3px 3px 0px #000000; }

    /* Steps */
    #moa-steps {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .moa-step {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px;
      background: #FFFFFF;
      border-radius: 8px;
      border: 2px solid #000000;
      box-shadow: 3px 3px 0px #000000;
      transition: all 0.2s;
      font-weight: 700;
    }
    .moa-step.active  { border-color: #000000; background: #FFDE59; box-shadow: 4px 4px 0px #000000; }
    .moa-step.done    { border-color: #000000; background: #D1FFD7; }
    .moa-step.failed  { border-color: #000000; background: #FFD1D1; }

    .moa-step-num {
      width: 22px; height: 22px;
      border-radius: 50%;
      font-size: 11px; font-weight: 900;
      display: flex; align-items: center; justify-content: center;
      background: #000000; color: #FFFFFF;
      border: 1.5px solid #000000;
      flex-shrink: 0; transition: all 0.2s;
    }
    .moa-step.active .moa-step-num  { background: #FF3F6C; color: #FFF; border-color: #000; animation: moaPulse 1.2s infinite; }
    .moa-step.done   .moa-step-num  { background: #00E676; color: #000; border-color: #000; }
    .moa-step.failed .moa-step-num  { background: #FF4D4D; color: #FFF; border-color: #000; }
    @keyframes moaPulse { 0%,100%{box-shadow:0 0 0 0 rgba(255,63,108,0.4)} 50%{box-shadow:0 0 0 5px rgba(255,63,108,0)} }

    .moa-step-label { font-size: 11.5px; color: #000000; font-weight: 800; flex: 1; transition: color 0.2s; }
    .moa-step.active .moa-step-label { color: #000000; }
    .moa-step.done   .moa-step-label { color: #1B5E20; }
    .moa-step.failed .moa-step-label { color: #D32F2F; }
    .moa-step-icon   { font-size: 13px; }

    /* Log */
    #moa-log-wrap {
      margin: 0 12px 12px;
      background: #FFFFFF;
      border: 2.5px solid #000000;
      box-shadow: 4px 4px 0px #000000;
      border-radius: 8px;
      overflow: hidden;
    }
    #moa-log-head {
      padding: 6px 10px;
      font-size: 10px; font-weight: 900;
      color: #000000; text-transform: uppercase; letter-spacing: 0.7px;
      border-bottom: 2px solid #000000;
      background: #FFDE59;
    }
    #moa-log {
      height: 200px; overflow-y: auto;
      padding: 8px 10px;
      display: flex; flex-direction: column; gap: 4px;
      background: #FFFDF8;
    }
    #moa-log::-webkit-scrollbar { width: 4px; }
    #moa-log::-webkit-scrollbar-thumb { background: #000000; border-radius: 2px; }
    .moa-log-line {
      font-size: 11px; line-height: 1.5; color: #000000; font-weight: 700;
      display: flex; gap: 6px;
      animation: moaSlideIn 0.15s ease;
    }
    @keyframes moaSlideIn { from{opacity:0;transform:translateY(3px)} to{opacity:1;transform:none} }
    .moa-log-time { color: #555555; flex-shrink: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
    .moa-log-line.success .moa-log-msg { color: #1B5E20; }
    .moa-log-line.warning .moa-log-msg { color: #E65100; }
    .moa-log-line.error   .moa-log-msg { color: #D32F2F; }
    .moa-log-line.step    .moa-log-msg { color: #0277BD; font-weight: 800; }

    /* Quantity Input Row */
    #moa-qty-row {
      padding: 10px 12px 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #moa-qty-row label {
      font-size: 12px;
      color: #000000;
      font-weight: 800;
      white-space: nowrap;
    }
    #moa-qty-input {
      flex: 1;
      padding: 7px 10px;
      background: #FFFFFF;
      border: 2.5px solid #000000;
      box-shadow: 3px 3px 0px #000000;
      border-radius: 6px;
      color: #000000;
      font-family: inherit;
      font-size: 12px;
      font-weight: 800;
      outline: none;
      text-align: center;
      transition: all 0.15s;
    }
    #moa-qty-input:focus {
      background: #FFFDF0;
      box-shadow: 4px 4px 0px #000000;
      transform: translate(-1px, -1px);
    }

    /* Picklist Input */
    #moa-picklist-row {
      padding: 6px 12px 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #moa-picklist-row label {
      font-size: 12px;
      color: #000000;
      font-weight: 800;
      white-space: nowrap;
    }
    #moa-picklist-input {
      flex: 1;
      padding: 7px 10px;
      background: #FFFFFF;
      border: 2.5px solid #000000;
      box-shadow: 3px 3px 0px #000000;
      border-radius: 6px;
      color: #000000;
      font-family: inherit;
      font-size: 12px;
      font-weight: 800;
      outline: none;
      transition: all 0.15s;
    }
    #moa-picklist-input:focus {
      background: #FFFDF0;
      box-shadow: 4px 4px 0px #000000;
      transform: translate(-1px, -1px);
    }
    #moa-picklist-input::placeholder { color: #666666; font-weight: 500; }

    #moa-resume-btn {
      flex-shrink: 0;
      padding: 7px 14px;
      background: #00E5FF;
      border: 2.5px solid #000000;
      box-shadow: 3px 3px 0px #000000;
      border-radius: 6px;
      color: #000000;
      font-family: inherit;
      font-size: 11px;
      font-weight: 900;
      cursor: pointer;
      transition: all 0.15s;
    }
    #moa-resume-btn:hover {
      transform: translate(-1px, -1px);
      box-shadow: 4px 4px 0px #000000;
    }
    #moa-resume-btn:active {
      transform: translate(1px, 1px);
      box-shadow: 1px 1px 0px #000000;
    }
    #moa-resume-btn:disabled {
      background: #EAE5D9;
      color: #777777;
      box-shadow: 2px 2px 0px #000000;
      cursor: not-allowed;
      transform: none;
    }

    .moa-or-divider {
      padding: 4px 12px;
      text-align: center;
      font-size: 10px;
      color: #000000;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Order Type Radio Group */
    #moa-ordertype-row {
      padding: 6px 12px 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #moa-ordertype-row .moa-ot-label {
      font-size: 12px;
      color: #000000;
      font-weight: 800;
      white-space: nowrap;
      margin-right: 2px;
    }
    .moa-radio-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      background: #FFFFFF;
      border: 2px solid #000000;
      box-shadow: 2.5px 2.5px 0px #000000;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .moa-radio-pill:hover {
      background: #FAF8F0;
      transform: translate(-1px, -1px);
    }
    .moa-radio-pill input[type="radio"] {
      appearance: none;
      -webkit-appearance: none;
      width: 13px; height: 13px;
      border: 2px solid #000000;
      border-radius: 50%;
      margin: 0;
      cursor: pointer;
      position: relative;
      transition: all 0.15s;
    }
    .moa-radio-pill input[type="radio"]:checked {
      border-color: #000000;
      background: #FF3F6C;
      box-shadow: inset 0 0 0 2px #FFFFFF;
    }
    .moa-radio-pill span {
      font-size: 11px;
      color: #000000;
      font-weight: 800;
      cursor: pointer;
    }
    .moa-radio-pill:has(input:checked) {
      background: #FFDE59;
      box-shadow: 3px 3px 0px #000000;
    }

    /* Buttons */
    #moa-btn-row {
      padding: 12px;
      display: flex; gap: 8px;
    }
    #moa-start-btn {
      flex: 1;
      padding: 11px;
      background: #FF3F6C;
      border: 2.5px solid #000000;
      box-shadow: 4px 4px 0px #000000;
      border-radius: 8px;
      color: #FFFFFF; font-family: inherit; font-size: 13px; font-weight: 900;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      transition: all 0.15s;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #moa-start-btn:hover  { transform: translate(-2px, -2px); box-shadow: 6px 6px 0px #000000; }
    #moa-start-btn:active { transform: translate(2px, 2px); box-shadow: 2px 2px 0px #000000; }
    #moa-start-btn:disabled { background: #EAE5D9; color: #777777; box-shadow: 2px 2px 0px #000000; cursor: not-allowed; transform: none; }

    #moa-reset-btn {
      padding: 11px 16px;
      background: #FFFFFF;
      border: 2.5px solid #000000;
      box-shadow: 3px 3px 0px #000000;
      border-radius: 8px; color: #000000;
      font-family: inherit; font-size: 12px; font-weight: 800;
      cursor: pointer; transition: all 0.15s;
    }
    #moa-reset-btn:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0px #000000; background: #FAF8F0; }
    #moa-reset-btn:active { transform: translate(1px, 1px); box-shadow: 1px 1px 0px #000000; }

    #moa-spinner {
      width: 14px; height: 14px;
      border: 2.5px solid #FFFFFF;
      border-top-color: transparent; border-radius: 50%;
      animation: moaSpin 0.6s linear infinite;
      display: none;
    }
    #moa-start-btn.loading #moa-spinner { display: block; }
    #moa-start-btn.loading #moa-start-icon { display: none; }
    @keyframes moaSpin { to{transform:rotate(360deg)} }

    /* Neubrutalist FAB */
    #moa-fab {
      width: 56px; height: 56px;
      background: #FFDE59;
      border-radius: 12px;
      border: 3px solid #000000;
      box-shadow: 5px 5px 0px #000000;
      cursor: grab;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 2147483647;
      touch-action: none;
      user-select: none;
    }
    #moa-fab:hover { transform: translate(-2px, -2px); box-shadow: 7px 7px 0px #000000; }
    #moa-fab.moa-dragging { cursor: grabbing; transform: scale(1.08); box-shadow: 8px 8px 0px #000000; }
    #moa-fab svg { width: 28px; height: 28px; fill: #000000; pointer-events: none; }

    #moa-fab::after {
      content: 'Order Automation';
      position: absolute;
      right: calc(100% + 12px);
      top: 50%; transform: translateY(-50%);
      background: #FFFFFF;
      color: #000000;
      font-size: 11px; font-weight: 800;
      padding: 6px 12px; border-radius: 6px;
      white-space: nowrap;
      border: 2px solid #000000;
      box-shadow: 3px 3px 0px #000000;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
    }
    #moa-fab:hover::after { opacity: 1; }
    #moa-fab.moa-dragging::after { opacity: 0; }

    #moa-fab-badge {
      position: absolute;
      top: -6px; right: -6px;
      min-width: 20px; height: 20px;
      background: #00E676;
      border-radius: 10px;
      font-size: 11px; font-weight: 900; color: #000000;
      display: none; align-items: center; justify-content: center;
      padding: 0 4px;
      border: 2px solid #000000;
      box-shadow: 2px 2px 0px #000000;
      pointer-events: none;
    }
    #moa-fab-badge.show { display: flex; }
    #moa-fab-badge.error { background: #FF4D4D; color: #FFFFFF; }

    /* Product Card Container */
    #moa-product-card {
      margin: 12px;
      animation: moaSlideIn 0.3s ease;
    }
    .moa-pc-header {
      padding: 10px 14px;
      background: #FFDE59;
      border: 2.5px solid #000000;
      box-shadow: 3px 3px 0px #000000;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .moa-pc-badge {
      font-size: 11px;
      font-weight: 900;
      color: #000000;
      background: #FFFFFF;
      border: 2px solid #000000;
      padding: 3px 10px;
      border-radius: 6px;
      text-transform: uppercase;
    }
    .moa-pc-qty {
      font-size: 11px;
      font-weight: 800;
      color: #000000;
    }
    .moa-pc-order {
      font-size: 11px;
      font-weight: 800;
      color: #000000;
    }
    .moa-items-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 12px;
    }
    .moa-item-card {
      background: #FFFFFF;
      border: 2.5px solid #000000;
      box-shadow: 4px 4px 0px #000000;
      border-radius: 10px;
      overflow: hidden;
      transition: all 0.2s;
      animation: moaCardIn 0.35s ease both;
    }
    .moa-item-card:hover {
      transform: translate(-2px, -2px);
      box-shadow: 6px 6px 0px #000000;
    }
    @keyframes moaCardIn {
      from { opacity: 0; transform: translateY(10px) scale(0.97); }
      to   { opacity: 1; transform: none; }
    }
    .moa-item-img-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 3/4;
      background: #FAF8F0;
      border-bottom: 2px solid #000000;
      overflow: hidden;
    }
    .moa-item-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .moa-item-num {
      position: absolute;
      top: 8px;
      left: 8px;
      background: #000000;
      color: #FFFFFF;
      font-size: 11px;
      font-weight: 900;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1.5px solid #000000;
    }
    .moa-item-size {
      position: absolute;
      top: 8px;
      right: 8px;
      background: #FF3F6C;
      color: #FFFFFF;
      font-size: 10px;
      font-weight: 900;
      padding: 3px 10px;
      border-radius: 4px;
      border: 1.5px solid #000000;
      text-transform: uppercase;
    }
    .moa-item-details {
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .moa-item-brand {
      font-size: 10px;
      font-weight: 900;
      color: #FF3F6C;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .moa-item-name {
      font-size: 12.5px;
      font-weight: 800;
      color: #000000;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .moa-item-sku-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .moa-item-sku-label {
      font-size: 10px;
      color: #333333;
      font-weight: 800;
      white-space: nowrap;
    }
    .moa-item-sku-value {
      font-size: 11px;
      color: #000000;
      font-weight: 900;
      font-family: 'Courier New', monospace;
      background: #FFDE59;
      border: 1.5px solid #000;
      padding: 1px 6px;
      border-radius: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #moa-next-sku-btn {
      margin: 10px 12px;
      padding: 11px;
      background: #00E676;
      border: 2.5px solid #000000;
      box-shadow: 4px 4px 0px #000000;
      border-radius: 8px;
      color: #000000;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 900;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      transition: all 0.15s;
      width: calc(100% - 24px);
      text-transform: uppercase;
    }
    #moa-next-sku-btn:hover {
      transform: translate(-2px, -2px);
      box-shadow: 6px 6px 0px #000000;
    }

    #moa-cover-id-row {
      margin: 10px 12px;
      padding: 14px;
      background: #FFFDF0;
      border: 2.5px solid #000000;
      box-shadow: 4px 4px 0px #000000;
      border-radius: 10px;
    }
    .moa-cid-title {
      font-size: 13px;
      font-weight: 900;
      color: #000000;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .moa-cid-form {
      display: flex;
      gap: 8px;
    }
    #moa-cover-id-input {
      flex: 1;
      padding: 9px 12px;
      background: #FFFFFF;
      border: 2px solid #000000;
      box-shadow: 2.5px 2.5px 0px #000000;
      border-radius: 6px;
      color: #000000;
      font-family: inherit;
      font-size: 13px;
      font-weight: 800;
      outline: none;
    }
    #moa-cover-id-submit {
      padding: 9px 16px;
      background: #00E5FF;
      border: 2px solid #000000;
      box-shadow: 2.5px 2.5px 0px #000000;
      border-radius: 6px;
      color: #000000;
      font-family: inherit;
      font-size: 12px;
      font-weight: 900;
      cursor: pointer;
      transition: all 0.15s;
    }
    #moa-cover-id-submit:hover {
      transform: translate(-1px, -1px);
      box-shadow: 4px 4px 0px #000000;
    }

    /* Auth Notification Banner */
    #moa-auth-banner {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 380px;
      max-width: calc(100vw - 32px);
      background: #FFFDF6;
      border: 3px solid #000000;
      border-radius: 12px;
      box-shadow: 6px 6px 0px #000000;
      z-index: 2147483647;
      display: none;
      flex-direction: column;
      overflow: hidden;
      animation: moaBannerSlideIn 0.4s ease;
      font-family: system-ui, sans-serif;
      color: #000000;
    }
    #moa-auth-banner.show { display: flex; }
    @keyframes moaBannerSlideIn {
      from { opacity: 0; transform: translateX(40px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    #moa-auth-banner-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      background: #FFDE59;
      border-bottom: 2px solid #000000;
    }
    #moa-auth-banner-header .moa-ab-icon {
      width: 34px; height: 34px;
      background: #FF3F6C;
      border: 2px solid #000000;
      box-shadow: 2px 2px 0px #000000;
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; color: #FFFFFF;
      flex-shrink: 0;
    }
    #moa-auth-banner-header .moa-ab-title { font-size: 13px; font-weight: 900; color: #000; text-transform: uppercase; }
    #moa-auth-banner-header .moa-ab-sub   { font-size: 10px; font-weight: 700; color: #222; margin-top: 1px; }
    #moa-auth-banner-close {
      margin-left: auto; background: #FFFFFF; border: 2px solid #000;
      box-shadow: 2px 2px 0px #000; cursor: pointer; color: #000; font-size: 14px; font-weight: 900;
      padding: 3px 6px; border-radius: 4px; transition: all 0.15s;
    }
    #moa-auth-banner-close:hover { background: #FF3F6C; color: #FFF; }
    #moa-auth-banner-body { padding: 12px 14px; }
    #moa-auth-banner-msg {
      font-size: 12px; font-weight: 700; color: #000; line-height: 1.5;
      padding: 10px 12px; background: #FFFDF0; border: 2px solid #000;
      box-shadow: 2.5px 2.5px 0px #000; border-radius: 6px; margin-bottom: 12px;
    }
    #moa-auth-banner-msg .moa-ab-highlight { color: #FF3F6C; font-weight: 900; }
    #moa-auth-banner-actions { display: flex; gap: 8px; }
    #moa-auth-banner-open {
      flex: 1; padding: 10px; background: #FF3F6C; border: 2px solid #000;
      box-shadow: 3px 3px 0px #000; border-radius: 6px; color: #FFF;
      font-family: inherit; font-size: 12px; font-weight: 900; cursor: pointer;
      transition: all 0.15s; text-transform: uppercase;
    }
    #moa-auth-banner-open:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0px #000; }
    #moa-auth-banner-dismiss {
      padding: 10px 14px; background: #FFFFFF; border: 2px solid #000;
      box-shadow: 3px 3px 0px #000; border-radius: 6px; color: #000;
      font-family: inherit; font-size: 12px; font-weight: 800; cursor: pointer;
      transition: all 0.15s;
    }
    #moa-auth-banner-dismiss:hover { background: #FAF8F0; transform: translate(-1px, -1px); }

    /* Summary Card */
    #moa-summary-card {
      margin: 12px; padding: 14px; background: #FFFFFF;
      border: 2.5px solid #000000; box-shadow: 4px 4px 0px #000000; border-radius: 10px;
    }
    .moa-summary-header {
      padding: 10px 14px; background: #FFDE59; border: 2px solid #000000;
      box-shadow: 3px 3px 0px #000000; border-radius: 8px; display: flex;
      justify-content: space-between; align-items: center; margin-bottom: 12px;
    }
    .moa-summary-title { font-size: 14px; font-weight: 900; color: #000000; text-transform: uppercase; }
    .moa-summary-time  { font-size: 11px; font-weight: 800; color: #000000; }
    .moa-summary-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 12px; }
    .moa-stat-card {
      background: #FFFDF0; border: 2px solid #000000; box-shadow: 3px 3px 0px #000000;
      border-radius: 8px; padding: 10px 12px; text-align: center;
    }
    .moa-stat-value { font-size: 22px; font-weight: 900; color: #000000; }
    .moa-stat-value.accent { color: #FF3F6C; }
    .moa-stat-value.green  { color: #1B5E20; }
    .moa-stat-value.blue   { color: #0277BD; }
    .moa-stat-value.yellow { color: #E65100; }
    .moa-stat-label { font-size: 10.5px; font-weight: 800; color: #000000; text-transform: uppercase; margin-top: 4px; }
    .moa-summary-table {
      width: 100%; border-collapse: collapse; background: #FFFFFF;
      border: 2px solid #000000; box-shadow: 3px 3px 0px #000000; border-radius: 8px; overflow: hidden;
    }
    .moa-summary-table th {
      padding: 8px 12px; font-size: 10.5px; font-weight: 900; color: #000000;
      text-transform: uppercase; background: #FFDE59; border-bottom: 2px solid #000000; text-align: left;
    }
    .moa-summary-table td { padding: 8px 12px; font-size: 12px; font-weight: 700; color: #000000; border-bottom: 1.5px solid #000000; }
    .moa-summary-table tr:last-child td { border-bottom: none; }
    .moa-summary-table .sku-code { font-family: 'Courier New', monospace; font-weight: 900; color: #000000; background: #FFDE59; padding: 1px 6px; border: 1px solid #000; border-radius: 4px; }
    .moa-summary-table .sku-orders { font-weight: 900; color: #FF3F6C; text-align: center; }
    .moa-summary-picklist {
      margin-top: 10px; padding: 8px 12px; background: #FFFDF0;
      border: 2px solid #000000; box-shadow: 2.5px 2.5px 0px #000000; border-radius: 6px;
      font-size: 11px; font-weight: 800; color: #000000; display: flex; align-items: center; gap: 6px;
    }
    .moa-summary-picklist strong { color: #000000; font-weight: 900; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);

  const wrap = document.createElement('div');
  wrap.id = 'moa-fab-wrap';
  wrap.style.cssText = 'position:fixed;bottom:28px;right:28px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-family:Inter,system-ui,sans-serif;';
  wrap.innerHTML = `
    <!-- Panel -->
    <div id="moa-panel">
      <div id="moa-panel-header">
        <div class="moa-logo">M</div>
        <div>
          <div class="moa-title">Myntra Automation-RM</div>
          <div class="moa-sub">mdirect.myntrainfo.com</div>
        </div>
        <button id="moa-close" title="Close">✕</button>
      </div>

      <div id="moa-panel-body">
        <div class="moa-col-left">
          <div id="moa-picklist-row">
            <label for="moa-picklist-input">📋 Resume:</label>
            <input id="moa-picklist-input" type="text" placeholder="OP20113317" title="Enter existing picklist barcode to skip Step 1">
            <button id="moa-resume-btn" title="Resume processing from existing picklist">Resume ▶</button>
          </div>

          <div class="moa-or-divider">── or generate new ──</div>

          <div id="moa-qty-row">
            <label for="moa-qty-input">📦 Orders:</label>
            <input id="moa-qty-input" type="number" min="1" max="9999" value="100" title="Number of orders for picklist">
          </div>

          <div id="moa-ordertype-row">
            <span class="moa-ot-label">📝 Type:</span>
            <label class="moa-radio-pill">
              <input type="radio" name="moa-ordertype" value="BOTH" checked>
              <span>Both</span>
            </label>
            <label class="moa-radio-pill">
              <input type="radio" name="moa-ordertype" value="SINGLE">
              <span>Single</span>
            </label>
            <label class="moa-radio-pill">
              <input type="radio" name="moa-ordertype" value="MULTI">
              <span>Multi</span>
            </label>
          </div>

          <div id="moa-btn-row">
            <button id="moa-start-btn">
              <div id="moa-spinner"></div>
              <span id="moa-start-icon">▶</span>
              <span id="moa-start-label">Start Automation</span>
            </button>
            <button id="moa-reset-btn" title="Reset">↺</button>
          </div>

          <div id="moa-steps">
            <div class="moa-step" id="moa-step-1">
              <div class="moa-step-num">1</div>
              <div class="moa-step-label">Generate Picklist</div>
              <div class="moa-step-icon">📋</div>
            </div>
            <div class="moa-step" id="moa-step-2">
              <div class="moa-step-num">2</div>
              <div class="moa-step-label">Fetch Picklist Status</div>
              <div class="moa-step-icon">🔍</div>
            </div>
            <div class="moa-step" id="moa-step-3">
              <div class="moa-step-num">3</div>
              <div class="moa-step-label">QC Pass</div>
              <div class="moa-step-icon">✅</div>
            </div>
            <div class="moa-step" id="moa-step-4">
              <div class="moa-step-num">4</div>
              <div class="moa-step-label">Mark Ready to Ship</div>
              <div class="moa-step-icon">📦</div>
            </div>
            <div class="moa-step" id="moa-step-5">
              <div class="moa-step-num">5</div>
              <div class="moa-step-label">Print Invoice &amp; Label</div>
              <div class="moa-step-icon">🖨️</div>
            </div>
          </div>
          
          <div id="moa-log-wrap">
            <div id="moa-log-head">📟 Activity Log</div>
            <div id="moa-log"><span style="color:#555d7a;font-size:10.5px;">Awaiting start…</span></div>
          </div>
        </div>

        <div class="moa-col-right">
          <div id="moa-product-card" style="display:none;"></div>
          <button id="moa-next-sku-btn" style="display:none;">▶ Process Next SKU</button>
          <div id="moa-cover-id-row" style="display:none;">
            <div class="moa-cid-title">📷 Scan Cover ID</div>
            <div class="moa-cid-form">
              <input id="moa-cover-id-input" type="text" placeholder="Scan or type cover barcode…" autofocus />
              <button id="moa-cover-id-submit">Confirm ✓</button>
            </div>
          </div>
        </div>
      </div>
    </div>

  `;

  // FAB is injected separately (fixed-position, not inside the wrap flex flow)
  const fabEl = document.createElement('button');
  fabEl.id = 'moa-fab';
  fabEl.title = 'Myntra Order Automation';
  fabEl.innerHTML = `
    <div id="moa-fab-badge"></div>
    <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>
  `;

  document.body.appendChild(wrap);
  document.body.appendChild(fabEl);

  // Backdrop overlay for centered panel
  const backdrop = document.createElement('div');
  backdrop.id = 'moa-backdrop';
  document.body.appendChild(backdrop);

  // ── UI wiring ───────────────────────────────────────────────
  const panel = document.getElementById('moa-panel');
  const fab = document.getElementById('moa-fab');
  const badge = document.getElementById('moa-fab-badge');
  const closeBtn = document.getElementById('moa-close');
  const startBtn = document.getElementById('moa-start-btn');
  const resetBtn = document.getElementById('moa-reset-btn');
  const logEl = document.getElementById('moa-log');
  const startLbl = document.getElementById('moa-start-label');
  const productCard = document.getElementById('moa-product-card');
  const nextSkuBtn = document.getElementById('moa-next-sku-btn');
  const coverIdRow = document.getElementById('moa-cover-id-row');
  const coverIdInput = document.getElementById('moa-cover-id-input');
  const coverIdSubmit = document.getElementById('moa-cover-id-submit');

  const qtyInput = document.getElementById('moa-qty-input');
  const picklistInput = document.getElementById('moa-picklist-input');
  const resumeBtn = document.getElementById('moa-resume-btn');

  // ── Make FAB draggable (mouse + touch) ───────────────────
  let isDragging = false;
  let hasDragged = false;
  let dragStartX, dragStartY, fabStartX, fabStartY;

  function onDragStart(e) {
    isDragging = true;
    hasDragged = false;
    const point = e.touches ? e.touches[0] : e;
    dragStartX = point.clientX;
    dragStartY = point.clientY;
    const rect = fab.getBoundingClientRect();
    fabStartX = rect.left;
    fabStartY = rect.top;
    fab.classList.add('moa-dragging');
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const point = e.touches ? e.touches[0] : e;
    const dx = point.clientX - dragStartX;
    const dy = point.clientY - dragStartY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasDragged = true;
    let newX = fabStartX + dx;
    let newY = fabStartY + dy;
    // Clamp within viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    newX = Math.max(0, Math.min(newX, vw - 54));
    newY = Math.max(0, Math.min(newY, vh - 54));
    fab.style.left = newX + 'px';
    fab.style.top = newY + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    // Also reposition the panel wrapper near the FAB
    wrap.style.left = (newX - 340 + 54) + 'px';
    wrap.style.top = 'auto';
    wrap.style.right = 'auto';
    wrap.style.bottom = (vh - newY + 10) + 'px';
    e.preventDefault();
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    fab.classList.remove('moa-dragging');
  }

  fab.addEventListener('mousedown', onDragStart);
  fab.addEventListener('touchstart', onDragStart, { passive: false });
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchend', onDragEnd);

  fab.addEventListener('click', async (e) => {
    // Only toggle panel if user didn't drag
    if (hasDragged) { hasDragged = false; return; }
    const isOpen = panel.classList.contains('open');
    if (!isOpen) {
      // Opening the panel — check license status and show warning if not authorized
      panel.classList.add('open');
      backdrop.classList.add('open');
      try {
        const licStatus = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
            if (chrome.runtime.lastError) resolve({ licensed: false, message: 'Extension error.' });
            else resolve(resp || { licensed: false, message: 'No response.' });
          });
        });
        if (!licStatus.licensed) {
          addLog(`🔒 ${licStatus.message || 'Not logged in or subscription inactive. Open extension popup to login/renew.'}`, 'error');
          startBtn.disabled = true;
          resumeBtn.disabled = true;
          startLbl.textContent = '🔒 Locked';
        } else {
          // Authorized — ensure buttons are enabled (unless automation is running)
          if (!startBtn.classList.contains('loading')) {
            startBtn.disabled = false;
            resumeBtn.disabled = false;
            startLbl.textContent = 'Start Automation';
          }
        }
      } catch (_) { /* ignore — automation will re-check anyway */ }
    } else {
      panel.classList.remove('open');
      backdrop.classList.remove('open');
    }
  });
  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    backdrop.classList.remove('open');
  });
  backdrop.addEventListener('click', () => {
    panel.classList.remove('open');
    backdrop.classList.remove('open');
  });

  function addLog(msg, type = 'info') {
    const empties = logEl.querySelectorAll('span[style]');
    empties.forEach(e => e.remove());

    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const line = document.createElement('div');
    line.className = `moa-log-line ${type}`;
    line.innerHTML = `<span class="moa-log-time">${time}</span><span class="moa-log-msg">${escHtml(msg)}</span>`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStep(n, state) {
    const el = document.getElementById(`moa-step-${n}`);
    if (!el) return;
    el.classList.remove('active', 'done', 'failed');
    if (state) el.classList.add(state);
  }

  function resetAll() {
    for (let i = 1; i <= 5; i++) setStep(i, '');
    logEl.innerHTML = '<span style="color:#555d7a;font-size:10.5px;">Awaiting start…</span>';
    startBtn.disabled = false;
    startBtn.classList.remove('loading');
    startLbl.textContent = 'Start Automation';
    badge.className = '';
    badge.textContent = '';
    if (productCard) productCard.style.display = 'none';
    if (nextSkuBtn) nextSkuBtn.style.display = 'none';
    if (coverIdRow) coverIdRow.style.display = 'none';
    if (resumeBtn) resumeBtn.disabled = false;
  }

  resetBtn.addEventListener('click', () => {
    resetAll();
    chrome.runtime.sendMessage({ action: 'RESET' });
  });

  startBtn.addEventListener('click', async () => {
    if (startBtn.disabled) return;

    // ── License gate: check login + active subscription ──
    startBtn.disabled = true;
    startLbl.textContent = 'Verifying…';
    try {
      const licStatus = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
          if (chrome.runtime.lastError) resolve({ licensed: false, message: 'Extension error.' });
          else resolve(resp || { licensed: false, message: 'No response.' });
        });
      });
      if (!licStatus.licensed) {
        addLog(`🔒 ${licStatus.message || 'Not logged in or subscription expired. Open extension popup to login/renew.'}`, 'error');
        startBtn.disabled = false;
        startLbl.textContent = 'Start Automation';
        return;
      }
    } catch (e) {
      addLog(`🔒 License check failed: ${e.message}`, 'error');
      startBtn.disabled = false;
      startLbl.textContent = 'Start Automation';
      return;
    }

    // Read quantity from input (default 100, min 1)
    let quantity = parseInt(qtyInput.value, 10);
    if (isNaN(quantity) || quantity < 1) quantity = 100;
    qtyInput.value = quantity;

    // Read order type from radio buttons
    const orderType = wrap.querySelector('input[name="moa-ordertype"]:checked')?.value || 'BOTH';

    resumeBtn.disabled = true;
    startBtn.classList.add('loading');
    startLbl.textContent = 'Running…';
    badge.className = 'show';
    badge.textContent = '…';

    addLog(`🚀 Starting automation (${quantity} ${orderType.toLowerCase()} order${quantity > 1 ? 's' : ''})…`, 'step');

    const tabs = await chrome.runtime.sendMessage({ action: 'GET_CURRENT_TAB' });
    const tabId = tabs?.tabId;

    chrome.runtime.sendMessage({
      action: 'START_AUTOMATION',
      tabId: tabId,
      quantity: String(quantity),
      orderType: orderType
    });
  });

  // ── Resume Existing Picklist ────────────────────────────
  resumeBtn.addEventListener('click', async () => {
    if (resumeBtn.disabled) return;
    const picklistBarcode = (picklistInput?.value || '').trim();
    if (!picklistBarcode) {
      addLog('⚠ Please enter a picklist barcode (e.g. OP20113317)', 'warning');
      picklistInput.focus();
      return;
    }

    // ── License gate: check login + active subscription ──
    resumeBtn.disabled = true;
    try {
      const licStatus = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
          if (chrome.runtime.lastError) resolve({ licensed: false, message: 'Extension error.' });
          else resolve(resp || { licensed: false, message: 'No response.' });
        });
      });
      if (!licStatus.licensed) {
        addLog(`🔒 ${licStatus.message || 'Not logged in or subscription expired. Open extension popup to login/renew.'}`, 'error');
        resumeBtn.disabled = false;
        return;
      }
    } catch (e) {
      addLog(`🔒 License check failed: ${e.message}`, 'error');
      resumeBtn.disabled = false;
      return;
    }

    startBtn.disabled = true;
    startBtn.classList.add('loading');
    startLbl.textContent = 'Resuming…';
    badge.className = 'show';
    badge.textContent = '…';

    addLog(`🔄 Resuming from existing picklist: ${picklistBarcode}`, 'step');

    const tabs = await chrome.runtime.sendMessage({ action: 'GET_CURRENT_TAB' });
    const tabId = tabs?.tabId;

    chrome.runtime.sendMessage({
      action: 'START_AUTOMATION',
      tabId: tabId,
      existingPicklistBarcode: picklistBarcode,
    });
  });

  // ── Next SKU button handler ─────────────────────────────
  if (nextSkuBtn) {
    nextSkuBtn.addEventListener('click', () => {
      nextSkuBtn.style.display = 'none';
      chrome.runtime.sendMessage({ action: 'NEXT_SKU_CONFIRMED' });
      addLog('▶ Proceeding to next SKU…', 'step');
    });
  }

  // ── Receive progress from background.js ───────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'LOG':
        addLog(msg.text, msg.level || 'info');
        break;
      case 'STEP_ACTIVE':
        setStep(msg.step, 'active');
        badge.className = 'show';
        badge.textContent = msg.step;
        break;
      case 'STEP_DONE':
        setStep(msg.step, 'done');
        break;
      case 'STEP_FAILED':
        setStep(msg.step, 'failed');
        badge.className = 'show error';
        badge.textContent = '!';
        break;
      case 'DONE':
        startBtn.disabled = false;
        startBtn.classList.remove('loading');
        startLbl.textContent = 'Start Automation';
        badge.className = 'show';
        badge.textContent = '✓';
        addLog('🎉 All steps complete!', 'success');
        break;
      case 'ERROR':
        startBtn.disabled = false;
        startBtn.classList.remove('loading');
        startLbl.textContent = 'Start Automation';
        addLog(`❌ ${msg.text}`, 'error');
        badge.className = 'show error';
        badge.textContent = '!';
        break;
      case 'LICENSE_INVALID':
        startBtn.disabled = true;
        resumeBtn.disabled = true;
        startBtn.classList.remove('loading');
        startLbl.textContent = '🔒 Locked';
        addLog(`🔒 ${msg.message || 'License invalid. Please login and ensure subscription is active.'}`, 'error');
        badge.className = 'show error';
        badge.textContent = '🔒';
        break;
      case 'SHOW_PRODUCT_CARD': {
        if (productCard) {
          const items = msg.items || [];
          const totalItems = msg.totalItems || items.length;
          const skuLabel = `SKU ${msg.currentSku || '?'}/${msg.totalSkus || '?'}`;
          const orderLabel = `Order #${msg.orderNumber || '?'}`;

          let html = `
            <div class="moa-pc-header">
              <span class="moa-pc-badge">${skuLabel}</span>
              <span class="moa-pc-order">${orderLabel}</span>
              <span class="moa-pc-qty">${totalItems} item${totalItems > 1 ? 's' : ''}</span>
            </div>
            <div class="moa-items-grid">
          `;

          items.forEach((item, idx) => {
            html += `
              <div class="moa-item-card" style="animation-delay:${idx * 0.08}s">
                <div class="moa-item-img-wrap">
                  <img class="moa-item-img" src="${escHtml(item.imageUrl || '')}" alt="${escHtml(item.productName || 'Product')}" onerror="this.style.display='none'" />
                  <span class="moa-item-num">#${idx + 1}</span>
                  ${item.size ? `<span class="moa-item-size">${escHtml(item.size)}</span>` : ''}
                </div>
                <div class="moa-item-details">
                  ${item.brand ? `<div class="moa-item-brand">${escHtml(item.brand)}</div>` : ''}
                  <div class="moa-item-name">${escHtml(item.productName || 'Unknown Product')}</div>
                  <div class="moa-item-sku-row">
                    <span class="moa-item-sku-label">Myntra:</span>
                    <span class="moa-item-sku-value">${escHtml(item.myntraSkuCode || '')}</span>
                  </div>
                  <div class="moa-item-sku-row">
                    <span class="moa-item-sku-label">Seller:</span>
                    <span class="moa-item-sku-value">${escHtml(item.sellerSkuCode || '')}</span>
                  </div>
                </div>
              </div>
            `;
          });

          html += '</div>';
          productCard.innerHTML = html;
          productCard.style.display = 'block';
        }
        break;
      }
      case 'HIDE_PRODUCT_CARD':
        if (productCard) productCard.style.display = 'none';
        break;
      case 'ASK_COVER_ID': {
        if (coverIdRow) {
          coverIdRow.style.display = 'block';
          if (coverIdInput) {
            coverIdInput.value = '';
            coverIdInput.placeholder = msg.defaultCoverId ? `Default: ${msg.defaultCoverId}` : 'Scan cover barcode…';
            setTimeout(() => coverIdInput.focus(), 100);
          }
          addLog(`📷 Scan Cover ID for order #${msg.orderNumber || '?'} (${msg.skuCode || ''})`, 'step');
        }
        break;
      }
      case 'HIDE_COVER_ID':
        if (coverIdRow) coverIdRow.style.display = 'none';
        break;
      case 'SHOW_NEXT_SKU_BTN': {
        if (nextSkuBtn) {
          nextSkuBtn.textContent = `▶ Process Next SKU (${msg.nextSkuCode || 'next'})`;
          nextSkuBtn.style.display = 'flex';
        }
        break;
      }
      case 'HIDE_NEXT_SKU_BTN':
        if (nextSkuBtn) nextSkuBtn.style.display = 'none';
        break;
      case 'SHOW_SUMMARY': {
        if (productCard) {
          const s = msg.summary || {};
          const breakdown = s.skuBreakdown || [];

          let tableRows = '';
          breakdown.forEach((sku, idx) => {
            tableRows += `
              <tr>
                <td style="text-align:center;color:#555d7a;font-size:11px;">${idx + 1}</td>
                <td class="sku-code">${escHtml(sku.skuCode || '')}</td>
                <td style="font-size:11px;color:#8b90a8;">${escHtml(sku.sellerSkuCode || '')}</td>
                <td class="sku-orders">${sku.ordersProcessed || 0}</td>
              </tr>
            `;
          });

          let summaryHtml = `
            <div id="moa-summary-card">
              <div class="moa-summary-header">
                <span class="moa-summary-title">🎉 Processing Complete</span>
                <span class="moa-summary-time">⏱ ${escHtml(s.elapsedFormatted || '0s')}</span>
              </div>

              <div class="moa-summary-stats">
                <div class="moa-stat-card">
                  <div class="moa-stat-value accent">${s.totalOrders || 0}</div>
                  <div class="moa-stat-label">Total Orders</div>
                </div>
                <div class="moa-stat-card">
                  <div class="moa-stat-value green">${s.totalSkus || 0}</div>
                  <div class="moa-stat-label">Total SKUs</div>
                </div>
                <div class="moa-stat-card">
                  <div class="moa-stat-value blue">${s.singleItemOrders || 0}</div>
                  <div class="moa-stat-label">Single Item Orders</div>
                </div>
                <div class="moa-stat-card">
                  <div class="moa-stat-value yellow">${s.multiItemOrders || 0}</div>
                  <div class="moa-stat-label">Multi Item Orders</div>
                </div>
              </div>

              ${breakdown.length > 0 ? `
                <table class="moa-summary-table">
                  <thead>
                    <tr>
                      <th style="text-align:center;width:30px;">#</th>
                      <th>Myntra SKU</th>
                      <th>Seller SKU</th>
                      <th style="text-align:center;">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                </table>
              ` : ''}

              ${s.picklistBarcode ? `
                <div class="moa-summary-picklist">
                  📋 Picklist: <strong>${escHtml(s.picklistBarcode)}</strong>
                </div>
              ` : ''}
            </div>
          `;

          productCard.innerHTML = summaryHtml;
          productCard.style.display = 'block';
        }
        break;
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  //  Auth & API helpers (used by background.js via messaging)
  // ─────────────────────────────────────────────────────────────
  function getAuthInfo() {
    const cookies = {};
    document.cookie.split(';').forEach(pair => {
      const [k, ...v] = pair.trim().split('=');
      if (k) cookies[k.trim()] = v.join('=');
    });

    const xsrf = cookies['x-myntra-xsrf-token'] || cookies['XSRF-TOKEN'] || '';

    let userLogin = '';
    try {
      for (const val of Object.values({ ...localStorage })) {
        try {
          const p = JSON.parse(val);
          if (p?.userLogin) { userLogin = p.userLogin; break; }
          if (p?.userId) { userLogin = p.userId; break; }
        } catch (_) { }
      }
    } catch (_) { }

    return { cookies, xsrf, userLogin };
  }

  async function callApi({ method = 'GET', url, body, extraHeaders = {}, skipBody = false }) {
    const { xsrf } = getAuthInfo();
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-myntra-xsrf-token': xsrf,
      ...extraHeaders
    };
    const opts = { method, headers, credentials: 'include' };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);

    // skipBody=true: don't read the response body (e.g. PDF blob downloads).
    // We only need the HTTP status to confirm the call succeeded.
    if (skipBody) {
      return { ok: resp.ok, status: resp.status, data: null };
    }

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { ok: resp.ok, status: resp.status, data };
  }

  // Single consolidated message listener
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'FETCH_API') {
      callApi(msg.payload)
        .then(result => sendResponse({ success: true, result }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (msg.action === 'GET_AUTH_INFO') {
      try {
        sendResponse({ success: true, authInfo: getAuthInfo() });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }

    // Return the dynamically discovered config values from the boot API
    if (msg.action === 'GET_DYNAMIC_CONFIG') {
      sendResponse({
        success: true,
        config: window.__moaDynConfig || {
          storePartnerIds: null,
          warehouseId: null,
          sellerId: null,
          discoveredFrom: null,
        },
      });
      return true;
    }
  });

  // ── Auto License Check on Page Load ─────────────────────────
  // Show a prominent notification banner if user is not logged in
  // or subscription is not active. Runs on every page load/reload.
  (function autoLicenseCheck() {
    // Create the notification banner element
    const banner = document.createElement('div');
    banner.id = 'moa-auth-banner';
    banner.innerHTML = `
      <div id="moa-auth-banner-header">
        <div class="moa-ab-icon">🔒</div>
        <div>
          <div class="moa-ab-title">Myntra Order Automation</div>
          <div class="moa-ab-sub">License Required</div>
        </div>
        <button id="moa-auth-banner-close" title="Dismiss">✕</button>
      </div>
      <div id="moa-auth-banner-body">
        <div id="moa-auth-banner-msg"></div>
        <div id="moa-auth-banner-actions">
          <button id="moa-auth-banner-open">🔑 Open Extension Popup</button>
          <button id="moa-auth-banner-dismiss">Dismiss</button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);

    // Wire close/dismiss buttons
    const closeBannerBtn = banner.querySelector('#moa-auth-banner-close');
    const dismissBtn = banner.querySelector('#moa-auth-banner-dismiss');
    const openPopupBtn = banner.querySelector('#moa-auth-banner-open');

    function hideBanner() {
      banner.classList.remove('show');
    }
    closeBannerBtn.addEventListener('click', hideBanner);
    dismissBtn.addEventListener('click', hideBanner);

    // Open extension popup — since we can't programmatically open popup,
    // we send a message that will highlight the extension icon
    openPopupBtn.addEventListener('click', () => {
      // Try to open popup via chrome API (won't work from content script,
      // but we can show a helpful alert)
      hideBanner();
      alert('👆 Click the Myntra Order Automation extension icon in your browser toolbar (top-right puzzle piece icon) to login or renew your subscription.');
    });

    // Check license after a short delay (let the page settle)
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
        if (chrome.runtime.lastError) return; // Extension context invalidated

        const msgEl = banner.querySelector('#moa-auth-banner-msg');
        const titleEl = banner.querySelector('.moa-ab-title');
        const subEl = banner.querySelector('.moa-ab-sub');
        const iconEl = banner.querySelector('.moa-ab-icon');

        if (!resp || !resp.licensed) {
          // Not logged in or subscription inactive
          const reason = resp?.message || 'Please login and ensure your subscription is active.';

          // Determine if it's a login issue or subscription issue
          const isLoginIssue = reason.toLowerCase().includes('not logged') || reason.toLowerCase().includes('login') || reason.toLowerCase().includes('re-login');
          const isExpired = reason.toLowerCase().includes('expired') || reason.toLowerCase().includes('renew');

          if (isLoginIssue) {
            iconEl.textContent = '🔑';
            titleEl.textContent = 'Login Required';
            subEl.textContent = 'Myntra Order Automation';
            msgEl.innerHTML = `<span class="moa-ab-highlight">You are not logged in.</span><br>Please open the extension popup and login with your account to use the automation tool.`;
            openPopupBtn.textContent = '🔑 Login Now';
          } else if (isExpired) {
            iconEl.textContent = '⏰';
            titleEl.textContent = 'Subscription Expired';
            subEl.textContent = 'Myntra Order Automation';
            banner.classList.add('expired');
            msgEl.innerHTML = `<span class="moa-ab-highlight">Your subscription has expired!</span><br>Please open the extension popup and renew your plan to continue using the automation tool.`;
            openPopupBtn.textContent = '💎 Renew Subscription';
          } else {
            iconEl.textContent = '🔒';
            titleEl.textContent = 'License Required';
            subEl.textContent = 'Myntra Order Automation';
            msgEl.innerHTML = `<span class="moa-ab-highlight">${reason}</span>`;
            openPopupBtn.textContent = '🔑 Open Extension Popup';
          }

          banner.classList.add('show');

          // Also lock the FAB panel buttons
          if (startBtn) startBtn.disabled = true;
          if (resumeBtn) resumeBtn.disabled = true;
          if (startLbl) startLbl.textContent = '🔒 Locked';
        }
        // If licensed — do nothing, banner stays hidden
      });
    }, 2000); // 2 second delay to let extension service worker wake up
  })();


} // end _moaInitUI

// ── DOM-ready dispatcher ─────────────────────────────────────
//  document_start fires before DOMContentLoaded. Defer UI init
//  until the body exists so we can safely append elements.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _moaInitUI);
} else {
  // DOM already ready (e.g. re-injection after page loaded)
  _moaInitUI();
}
