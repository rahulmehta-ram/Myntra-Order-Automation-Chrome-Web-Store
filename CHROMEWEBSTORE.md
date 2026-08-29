# Chrome Web Store Listing & Review Documentation

**Extension Name:** Myntra Automation-RM  
**Version:** 1.2.0  
**Manifest Version:** 3  
**Category:** Productivity / Workflow & Planning  

---

## 📝 Store Listing Metadata

### Short Description (Max 132 chars)
Automates the full Myntra Direct order processing flow: Picklist → QC Pass → Pack → Invoice & Label Print.

### Detailed Store Description
Myntra Order Automation streamlines e-commerce order fulfillment for sellers on the Myntra Direct Seller Portal (mdirect.myntrainfo.com). 

Instead of manually navigating through multiple pages and clicking repetitive steps for every order, this extension automates the entire fulfillment pipeline in 5 seamless steps:

1. Picklist Generation — Automatically creates picklists for specified order counts and order types (Single, Multi, or Both).
2. PDF Parsing & SKU Mapping — Downloads and parses picklist PDFs client-side using bundled pdf.js to extract exact product SKUs, quantities, and descriptions.
3. Automated Quality Control — Performs QC Pass validation for each item using active session credentials.
4. Ready-to-Ship (RTS) Packaging — Marks packets as Ready-To-Ship with optional barcode/cover ID scanning.
5. High-Speed Printing & PDF Saving — Directly prints Invoices and Shipping Labels to thermal printers (such as TSC DA310) via QZ Tray integration or auto-saves organized PDFs directly to your Downloads folder.

Key Highlights:
- Neubrutalist floating action panel injected into mdirect.myntrainfo.com
- Resume mode for existing picklist barcodes
- Per-SKU pause/resume options and live product card previews
- Multi-item batch tracking and detailed activity logs

---

## 🔒 Permissions Justification

Every permission declared in `manifest.json` is strictly required for the core extension functionality:

| Permission | Justification for Review Team |
| :--- | :--- |
| `activeTab` | Required to interact with the current Myntra Direct portal tab when the user clicks the extension action or floating control button. |
| `tabs` | Required to query and communicate with active Myntra tabs (`mdirect.myntrainfo.com`) to relay automation state updates and progress logs. |
| `storage` | Required to persist user preferences locally (printer selections, step delay duration, default Cover ID, PDF output directory). |
| `scripting` | Required to inject page-context helper functions for parsing picklist PDFs and managing QZ Tray printing. |
| `alarms` | Required to set a service worker keep-alive timer preventing Manifest V3 service worker termination during multi-minute order batch processing. |
| `downloads` | Required to automatically save generated invoice and shipping label PDF files to the local disk when PDF save mode is selected. |

### Host Permissions Justification

- `https://mdirect.myntrainfo.com/*`: The target seller portal domain where the content script and floating control UI are injected.
- `https://partnersapi.myntrainfo.com/*`: The backend API endpoint for Myntra Direct fulfillment calls (Picklist generation, Packets API, QC Pass, Ready-to-Ship, Invoice & Shipping Label fetch).
- `https://*.onrender.com/*`: License verification endpoint for checking active user subscriptions.

---

## 🛡️ Data Privacy & Security Disclosures

- **Single Purpose:** The sole purpose of this extension is to automate order fulfillment workflows on the Myntra Direct seller portal.
- **Data Collection:** No personal browsing data, web history, or sensitive user information is collected, sold, or transferred to third parties.
- **Local Storage:** All user configurations (printer selection, Cover ID, delays) are stored locally in Chrome's `chrome.storage.local`.
- **Remote Communications:** API calls are made directly to official Myntra seller endpoints (`partnersapi.myntrainfo.com`) using the user's existing authenticated session.

---

## 📦 Zip Packaging Exclusions

When preparing the .zip package for Chrome Developer Dashboard submission, ensure the following files are excluded:
- `.git/`
- `.gitignore`
- `.DS_Store`
- `README.md`
- `CHROMEWEBSTORE.md`
