# Myntra Order Automation (Chrome Web Store Extension)

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)
![Version](https://img.shields.io/badge/version-1.2.0-green.svg)
![Platform](https://img.shields.io/badge/platform-Chrome-orange.svg)

> **Automates the complete Myntra Direct seller order fulfillment pipeline:**  
> **Picklist Generation → PDF Parsing → Quality Control (QC Pass) → Ready-to-Ship (RTS) → Thermal Invoice & Label Printing / PDF Auto-Save.**

---

## 📌 Project Overview

**Myntra Order Automation** is a production-ready **Google Chrome Extension (Manifest V3)** built specifically for e-commerce sellers managing orders on the [Myntra Direct Seller Portal](https://mdirect.myntrainfo.com).

It eliminates manual, repetitive multi-step clicks by executing an end-to-end automated pipeline directly within the seller's browser session.

---

## ✨ Key Features

- **🚀 5-Step Order Processing Pipeline:**
  1. **Step 1: Picklist Generation** — Auto-generates picklists for specified order counts and types (`SINGLE`, `MULTI`, or `BOTH`).
  2. **Step 1b: Picklist PDF Download & Parsing** — Client-side parsing using bundled `pdf.js` to extract exact product SKUs, descriptions, quantities, and expiry dates.
  3. **Step 2: SKU Mapping Resolution** — Retrieves packet-to-SKU mappings via Myntra Packets API.
  4. **Step 3: Quality Control (QC Pass)** — Executes QC pass API calls per item with live session credentials.
  5. **Step 4: Ready-to-Ship (RTS)** — Marks packets as Ready-To-Ship with optional Cover ID / Barcode scanning.
  6. **Step 5: Thermal Print / PDF Save** — Direct printing of Invoices & Shipping Labels to thermal printers (e.g. TSC DA310) via QZ Tray or auto-saving PDFs into organized folders by SKU.

- **🎨 Neubrutalist Injected Control Panel:**
  - Floating Action Button (FAB) draggable to any position on `mdirect.myntrainfo.com`.
  - Real-time step progress indicators, activity logs, product card previews with images/sizes, and per-SKU pause/resume controls.

- **🔄 Picklist Resume Mode:**
  - Enter an existing picklist barcode (e.g., `OP20113317`) to resume processing without re-generating picklists.

- **📡 Dynamic Account Discovery:**
  - Intercepts boot API responses (`/api/boot/mdirect`, `/api/mdirect/warehouse`, `/api/mdirect/seller`) to auto-detect `storePartnerIds`, `warehouseId`, and `sellerId`.

- **🖨️ Thermal Printer & QZ Tray Integration:**
  - Pre-configured QZ Tray websocket integration with embedded RSA signing for silent, high-speed thermal printing to TSC, Zebra, and standard printers.

- **⚙️ Configurable Popup Settings:**
  - Set default Invoice & Label printers, Cover ID values, step delays (ms), SKU pause toggles, and PDF destination folders.

---

## 📂 Project Architecture

```
Myntra-Order-Automation-Chrome-Web-Store/
├── manifest.json         # Extension Manifest V3 declaration & permissions
├── background.js       # Service worker orchestrating the fulfillment pipeline
├── content.js          # Injected UI panel, FAB, and page-level API proxy
├── hook.js             # Network hook intercepting Myntra boot APIs
├── popup.html          # Extension toolbar popup interface
├── popup.js            # Settings manager & printer discovery logic
├── qz-tray.js          # Bundled QZ Tray web client library
├── pdfjs/              # Bundled PDF.js library for client-side PDF parsing
│   ├── pdf.min.js
│   └── pdf.worker.min.js
├── icons/              # Extension icons (16px, 32px, 48px, 128px)
├── .gitignore          # Excluded OS and environment files
├── CHROMEWEBSTORE.md   # Chrome Web Store submission metadata & justifications
└── README.md           # Project documentation
```

---

## 🛠️ Installation & Setup

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/rahulmehta-ram/Myntra-Order-Automation-Chrome-Web-Store.git
   ```

2. **Load into Google Chrome:**
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** using the toggle switch in the top-right corner.
   - Click **Load unpacked**.
   - Select the `Myntra-Order-Automation-Chrome-Web-Store` directory.

3. **Verify Thermal Printing Setup (Optional for Direct Printing):**
   - Download and start [QZ Tray](https://qz.io/download/) if printing directly to thermal printers (e.g. TSC DA310).
   - Alternatively, choose **"Save as PDF"** in extension settings to auto-download PDFs without QZ Tray.

---

## 📖 How to Use

1. Log in to your seller account at [https://mdirect.myntrainfo.com](https://mdirect.myntrainfo.com).
2. Click the floating **M** button on the bottom-right of the page to open the automation panel.
3. Choose your workflow:
   - **Generate New:** Set desired order quantity (e.g., `100`) and order type (`BOTH`, `SINGLE`, `MULTI`), then click **Start Automation**.
   - **Resume Picklist:** Enter your existing picklist barcode and click **Resume ▶**.
4. Monitor live progress, product card previews, and activity logs inside the injected control panel.
5. Invoices and shipping labels will automatically print to your selected printer or save to your `Downloads/MyntraOrders/<SKU>/` directory.

---

## 🔐 Required Permissions

| Permission | Purpose |
| :--- | :--- |
| `activeTab` | Access active Myntra Direct portal tab when triggered |
| `tabs` | Query and communicate with active Myntra tabs |
| `storage` | Store user settings (printer preferences, step delays, cover IDs) locally |
| `scripting` | Inject helper functions into page context for PDF parsing & QZ Tray printing |
| `alarms` | Service worker keep-alive mechanism during long automation batches |
| `downloads` | Save invoice and label PDF files directly to local disk |
| `host_permissions` | `https://mdirect.myntrainfo.com/*`, `https://partnersapi.myntrainfo.com/*`, `https://*.onrender.com/*` |

---

## 📄 License & Terms

Developed for Myntra Direct seller order management. All rights reserved.
