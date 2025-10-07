// ===== Config loader =====
async function loadConfig() {
  const res = await fetch("config/default.json");
  return res.json();
}

let ZOOM = 1;
let NAT_W = 0, NAT_H = 0;

function applyZoom() {
  const content = document.getElementById('mapContent');
  const scaled  = document.getElementById('scaled');
  if (!NAT_W || !NAT_H) return;

  // real scroll area = scaled size
  content.style.width  = (NAT_W * ZOOM) + 'px';
  content.style.height = (NAT_H * ZOOM) + 'px';

  // visual scale only on inner wrapper
  scaled.style.transform = `scale(${ZOOM})`;

  updateLayout();  // keeps it centered / clamps scroll
}

// ===== CSV parser (handles quotes/commas/newlines) =====
function parseCSV(text) {
  const rows = [];
  let i = 0, cur = "", inQuotes = false, row = [];

  function pushCell() { row.push(cur); cur = ""; }
  function pushRow()  { rows.push(row); row = []; }

  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { cur += '"'; i += 2; continue; }
      inQuotes = !inQuotes; i++; continue;
    }
    if (!inQuotes && ch === ",") { pushCell(); i++; continue; }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushCell(); pushRow(); i++; continue;
    }
    cur += ch; i++;
  }
  if (cur.length || row.length) { pushCell(); pushRow(); }

  const headers = (rows.shift() || []).map(h => h.trim());
  return rows
    .filter(r => r.length && r.some(c => (c || "").trim() !== ""))
    .map(r => {
      const o = {};
      headers.forEach((h, idx) => o[h] = (r[idx] || "").trim());
      return o;
    });
}

function centerIfSmaller() {
  const viewport = document.getElementById('mapViewport');
  const content  = document.getElementById('mapContent');

  const vw = viewport.clientWidth,  vh = viewport.clientHeight;
  const cw = content.scrollWidth;    // already NAT_W * ZOOM
  const ch = content.scrollHeight;   // already NAT_H * ZOOM

  // Center if the zoomed content is smaller than the viewport
  if (cw <= vw) viewport.scrollLeft = (cw - vw) / -2;
  if (ch <= vh) viewport.scrollTop  = (ch - vh) / -2;
}


function fitToViewport() {
  const viewport = document.getElementById('mapViewport');
  const img = document.getElementById('baseMap');
  if (!img.naturalWidth) return;

  // record natural size
  NAT_W = img.naturalWidth;
  NAT_H = img.naturalHeight;

  // pick a zoom that fits the whole image
  const scaleX = viewport.clientWidth  / NAT_W;
  const scaleY = viewport.clientHeight / NAT_H;
  ZOOM = Math.min(scaleX, scaleY);

  applyZoom();        // sizes #mapContent and scales #scaled
  centerIfSmaller();  // recenters if smaller than viewport
}

// ===== Pin factory =====
function makePin(xPercent, yPercent, color, address, primaryStatus, allStatuses = []) {
  const pin = document.createElement("div");
  pin.className = "pin";
  pin.dataset.status = primaryStatus;
  pin.dataset.statuses = (allStatuses || []).join(",");
  pin.dataset.primaryStatus = primaryStatus;

  const dot = document.createElement("div");
  dot.className = "dot";
  dot.style.background = color;
  pin.appendChild(dot);

  pin.title = address;
  pin.addEventListener("click", (e) => { e.stopPropagation(); showDetails(address); });

  const baseMap = document.getElementById("baseMap");
  if (!baseMap.complete) baseMap.addEventListener("load", () => positionPin(pin, baseMap, xPercent, yPercent));
  else positionPin(pin, baseMap, xPercent, yPercent);

  return pin;
}


function positionPin(pin, baseMap, xPercent, yPercent) {
  // Record natural image size once
  if (!NAT_W || !NAT_H) {
    NAT_W = baseMap.naturalWidth;
    NAT_H = baseMap.naturalHeight;
  }

  // Place pins in *natural pixel space* (before zoom)
  const left = (xPercent / 100) * NAT_W;
  const top  = (yPercent / 100) * NAT_H;

  pin.style.left = left + "px";
  pin.style.top  = top  + "px";
  pin.style.position = "absolute";
}

// ===== Details panel =====
let DATA = [];
let CFG  = {};

// ===== Details panel (clean version) =====
// Reuse the same labels you show in the legend
const STATUS_LABELS = {
  not_contacted:         "Not Yet Contacted",
  callback_today:        "Call Back Today",
  callback_week:         "Call Back This Week",
  callback_3m:           "Call Back in 3+ Months",
  interested:            "Interested in Valuation",
  no_answer_whatsapp:    "No Answer - sent WhatsApp",
  spoke_to_spouse:       "Spoke to Spouse",
  wrong_number:          "Wrong Number",
  not_interested:        "Not Interested"
};

function normalizeStatus(raw, cfg) {
  if (!raw) return "not_contacted";
  const alias = cfg.statusAliases?.[raw];
  return alias || String(raw).toLowerCase().replace(/\s+/g, "_");
}

function showDetails(address) {
  const detailsDiv = document.getElementById("details");

  // Find all rows for this address
  const rows = DATA.filter(r => String(r[CFG.idColumn]).trim() === String(address).trim());

  if (!rows.length) {
    detailsDiv.innerHTML = `
      <h3 style="margin:0 0 8px 0;">${address}</h3>
      <p>No details found.</p>
    `;
    return;
  }

  // helpers local to this function (so they won't clash with anything else)
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const labelForStatus = (key) => {
    for (const [label, mapped] of Object.entries(CFG.statusAliases || {})) {
      if (mapped === key) return label;
    }
    return String(key || "—").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  };
  const readableText = (bg) => {
    const hex = String(bg || "").replace("#","");
    const h = hex.length === 3 ? hex.split("").map(c=>c+c).join("") : hex;
    const r = parseInt(h.slice(0,2),16)||0, g = parseInt(h.slice(2,4),16)||0, b = parseInt(h.slice(4,6),16)||0;
    const L = 0.2126*r + 0.7152*g + 0.0722*b;
    return L > 160 ? "#000" : "#fff";
  };

  // StandID (first non-empty among the rows)
  const standId = (rows.find(r => r[CFG.standIdColumn]) || {})[CFG.standIdColumn] || "";

  let html = `
    <h3 style="margin:0 0 10px 0;">${escapeHtml(address)}</h3>
    <div style="margin:0 0 10px 0;"><strong>StandID:</strong> ${escapeHtml(standId || "—")}</div>
    <ul style="list-style:none; padding-left:0; margin:0;">
  `;

  rows.forEach(r => {
    const key     = normStatus(r[CFG.statusColumn]);
    const label   = labelForStatus(key);
    const bgColor = (CFG.statusColors && CFG.statusColors[key]) || "#999";
    const txt     = readableText(bgColor);

    html += `
      <li style="margin: 0 0 12px 0; padding: 0 0 12px 0; border-bottom: 1px solid #eee;">
        <div><strong>Resident:</strong> ${escapeHtml(r.Resident || "-")}</div>
        <div><strong>Phone1:</strong> ${escapeHtml(r.Phone1 || "-")}</div>
        <div><strong>Phone2:</strong> ${escapeHtml(r.Phone2 || "-")}</div>
        <div style="margin-top:6px; padding:6px 8px; border-radius:6px; background:${bgColor}; color:${txt}; display:inline-block;">
          <strong>Status:</strong> ${escapeHtml(label)}
        </div>
        <div style="margin-top:6px;"><strong>Notes:</strong> ${escapeHtml(r.Notes || "-")}</div>
      </li>
    `;
  });

  html += "</ul>";
  detailsDiv.innerHTML = html;
}

function pickPriorityStatus(rows, cfg) {
  // Highest → lowest urgency (tweak anytime)
  const order = [
    "not_contacted",
    "callback_today",
    "callback_week",
    "callback_3m",
    "interested",
    "no_answer_whatsapp",
    "spoke_to_spouse",
    "wrong_number",
    "not_interested"
  ];
  const rank = Object.fromEntries(order.map((s, i) => [s, i]));

  let best = "not_contacted";
  let bestRank = Infinity;
  rows.forEach(r => {
    const s = normStatus(r[cfg.statusColumn]);
    const rnk = rank[s] ?? 999;
    if (rnk < bestRank) { best = s; bestRank = rnk; }
  });
  return best;
}

function humanizeStatus(key) {
  // convert "callback_today" -> "Call back today"
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function renderLegend(cfg) {
  const block = document.getElementById("legendBlock");
  block.innerHTML = "";

  // Your order + labels; filtered to only those with a color in config
  const entries = [
    { key: "not_contacted",        label: "Not Yet Contacted" },
    { key: "callback_today",       label: "Call Back Today" },
    { key: "callback_week",        label: "Call Back This Week" },
    { key: "callback_3m",          label: "Call Back in 3+ Months" },
    { key: "interested",           label: "Interested in Valuation" },
    { key: "no_answer_whatsapp",   label: "No Answer - sent WhatsApp" },
    { key: "spoke_to_spouse",      label: "Spoke to Spouse"},
    { key: "wrong_number",         label: "Wrong Number" },
    { key: "not_interested",       label: "Not Interested"}
  ].filter(e => cfg.statusColors?.[e.key]);

  entries.forEach(({ key, label }) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.dataset.status = key; // for filtering

    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = cfg.statusColors[key];

    const text = document.createElement("span");
    text.textContent = label;

    item.append(dot, text);
    block.appendChild(item);

    // Click to toggle filter (click again to clear)
    item.addEventListener("click", () => {
      ACTIVE_STATUS = (ACTIVE_STATUS === key) ? null : key;
      applyFilter();
    });
  });

   // Clear filter button (appended to the end)
  const clearBtn = document.createElement("button");
  clearBtn.id = "legendClear";
  clearBtn.type = "button";
  clearBtn.textContent = "Clear filter";
  clearBtn.addEventListener("click", () => {
    ACTIVE_STATUS = null;
    applyFilter();
  });
  block.appendChild(clearBtn);

  // keep your existing layout tweak if you have it
  if (typeof adjustForLegend === "function") adjustForLegend();
}

function updateLayout() {
  const viewport = document.getElementById('mapViewport');
  const content  = document.getElementById('mapContent');

  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  // use the true scroll size of #mapContent
  const cw = content.scrollWidth;
  const ch = content.scrollHeight;

  // If the zoomed map is smaller than the viewport in BOTH directions,
  // center it and remove scroll. Otherwise, allow normal scrolling.
  if (cw <= vw && ch <= vh) {
    viewport.classList.add('centered');
    viewport.scrollLeft = 0;
    viewport.scrollTop  = 0;
  } else {
    viewport.classList.remove('centered');

    // Clamp scroll so you can’t scroll past the map
    const maxX = Math.max(0, cw - vw);
    const maxY = Math.max(0, ch - vh);
    viewport.scrollLeft = Math.min(viewport.scrollLeft, maxX);
    viewport.scrollTop  = Math.min(viewport.scrollTop,  maxY);
  }
}

function listUnplacedAddresses() {
  // group by Address
  const byAddr = {};
  DATA.forEach(r => {
    const addr = String(r[CFG.idColumn] || "").trim();
    if (!addr) return;
    (byAddr[addr] ||= []).push(r);
  });

  // keep only addresses where NONE of the rows has valid X & Y
  const items = Object.entries(byAddr).map(([addr, rows]) => {
    const hasXY = rows.some(r => Number.isFinite(parseFloat(r.X)) &&
                                 Number.isFinite(parseFloat(r.Y)));
    return { addr, rows, hasXY };
  }).filter(it => !it.hasXY);

  // sort alphabetically
  items.sort((a,b) => a.addr.localeCompare(b.addr));
  return items;
}

function populateUnplacedPicker() {
  const select = document.getElementById('addrSelect');
  if (!select) return;

  const items = listUnplacedAddresses();
  const prev = select.value;

  select.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = items.length
    ? `Select an address (${items.length})`
    : 'All addresses are placed 🎉';
  select.appendChild(opt0);

  items.forEach(({ addr, rows }) => {
    const firstRow = rows[0];
    const statusRaw = firstRow[CFG.statusColumn];
    const norm = normStatus(statusRaw);
    const color = CFG.statusColors[norm] || "#bbb";

    // Create a styled option with color dot
    const opt = document.createElement('option');
    opt.value = addr;
    opt.textContent = `  ● ${addr}`;
    opt.style.color = color;
    select.appendChild(opt);
  });

  // restore previous selection if still present
  if ([...select.options].some(o => o.value === prev)) {
    select.value = prev;
  }
}

function wirePickerEvents() {
  const select = document.getElementById('addrSelect');
  if (!select) return;
  select.addEventListener('change', () => {
    const addr = select.value;
    if (addr) showDetails(addr);
  });
}

// === Filtering state & helper ===
let ACTIVE_STATUS = null;

function applyFilter() {
  const content = document.getElementById('mapContent');
  const pins = document.querySelectorAll('#pinsLayer .pin');

  if (!ACTIVE_STATUS) {
    content.classList.remove('filtering');
    pins.forEach(p =>  {
      p.classList.remove('match');
      const dot = p.querySelector('.dot');
      const primary = p.dataset.primaryStatus;
      if (dot && primary && CFG.statusColors[primary]) {
        dot.style.background = CFG.statusColors[primary];
      }
    });

  } else {
    content.classList.add('filtering');
    pins.forEach(p => {
      const list = (p.dataset.statuses || "").split(",").filter(Boolean);
      const isMatch = list.includes(ACTIVE_STATUS);
      p.classList.toggle('match', isMatch);

      const dot = p.querySelector('.dot');
      if (!dot) return;
      if (isMatch && CFG.statusColors[ACTIVE_STATUS]) {
        dot.style.background = CFG.statusColors[ACTIVE_STATUS];
      } else {
        const primary = p.dataset.primaryStatus;
        if (primary && CFG.statusColors[primary]) {
          dot.style.background = CFG.statusColors[primary];
        }
      }
    });
  }

  // reflect selection in the legend
  document.querySelectorAll('#legendBlock .legend-item').forEach(li => {
    li.classList.toggle('active', li.dataset.status === ACTIVE_STATUS);
  });

    // NEW: toggle Clear button
  const clearBtn = document.getElementById('legendClear');
  if (clearBtn) {
    clearBtn.style.display = ACTIVE_STATUS ? 'inline-block' : 'none';
  }
}

// --- Single source of truth: normalize a raw sheet status to a key
function normStatus(raw) {
  if (!raw) return "not_contacted";
  const alias = CFG.statusAliases?.[raw];
  return alias || String(raw).toLowerCase().replace(/\s+/g, "_");
}

// ===== Init =====
(async function init() {
  try {
    CFG = await loadConfig();
    renderLegend(CFG);
    console.log("Config loaded:", CFG);

    const resp = await fetch(CFG.sheetCsvUrl);
    if (!resp.ok) throw new Error("Failed to fetch CSV: " + resp.status);
    const csvText = await resp.text();
    DATA = parseCSV(csvText);

    console.log("Rows parsed:", DATA.length);
    console.log("Headers seen:", Object.keys(DATA[0] || {}));

    const pinsLayer = document.getElementById("pinsLayer");

    // Group by Address (or whatever idColumn is)
    const grouped = {};
    DATA.forEach(r => {
      const key = String(r[CFG.idColumn] || "").trim();
      if (!key) return;
      (grouped[key] ||= []).push(r);
    });

    // Place one pin per address
    let pinsCount = 0;
    Object.entries(grouped).forEach(([address, rows]) => {
      const x = parseFloat(rows[0].X);
      const y = parseFloat(rows[0].Y);
      if (!isFinite(x) || !isFinite(y)) return;

      const primaryStatus = pickPriorityStatus(rows, CFG);
      const primaryColor  = CFG.statusColors[primaryStatus] || "#999";

      const allStatuses = Array.from(new Set(
        rows.map(r => normStatus(r[CFG.statusColumn]))
      )).filter(Boolean);

      const pin = makePin(x, y, primaryColor, address, primaryStatus, allStatuses);
      pinsLayer.appendChild(pin);

      pinsCount++;
    });

    console.log("Pins placed:", pinsCount);

    // If zero pins, drop a visible test pin so we know the layer works
    if (pinsCount === 0) {
      const test = makePin(50, 50, "#ff9800", "Test pin (no data placed)");
      pinsLayer.appendChild(test);
      console.warn("No pins from sheet — showing a test pin at 50%,50%. Check your sheet headers and X/Y values.");
    }
  } catch (err) {
    console.error(err);
  }
  populateUnplacedPicker();
  wirePickerEvents();
  fitToViewport();
})();

// ===== Zoom & Fit Wiring =====

// Buttons
document.getElementById('zoomIn').addEventListener('click', () => {
  ZOOM = Math.min(5, +(ZOOM * 1.2).toFixed(3));
  applyZoom(); updateLayout();
});
document.getElementById('zoomOut').addEventListener('click', () => {
  ZOOM = Math.max(0.2, +(ZOOM / 1.2).toFixed(3));
  applyZoom(); updateLayout();
});
document.getElementById('zoomReset').addEventListener('click', () => {
  fitToViewport(); // reset to full image
});

// Fit as soon as the image loads (normal load case)
const imgEl = document.getElementById('baseMap');
imgEl.addEventListener('load', () => {
  fitToViewport();
  document.getElementById('mapViewport').classList.remove('is-hidden');
});

// Handle cached/instant-load case too
if (imgEl.complete && imgEl.naturalWidth) {
  fitToViewport();
  document.getElementById('mapViewport').classList.remove('is-hidden');
}

// Refit on window resize
window.addEventListener('resize', () => {
  fitToViewport();
});

// ===== Click helper: log % coords when clicking on map viewport =====
document.getElementById("mapViewport").addEventListener("click", e => {
  const viewport  = e.currentTarget;
  const content   = document.getElementById("mapContent");
  const baseMap   = document.getElementById("baseMap");

  const rect = content.getBoundingClientRect();
  const vx = e.clientX - rect.left + viewport.scrollLeft;
  const vy = e.clientY - rect.top  + viewport.scrollTop;

  // Convert from *zoomed* pixel space to natural pixels
  const xInContent = vx / ZOOM;
  const yInContent = vy / ZOOM;

  const xPct = (xInContent / baseMap.naturalWidth)  * 100;
  const yPct = (yInContent / baseMap.naturalHeight) * 100;

  console.log("Click → use in sheet:", xPct.toFixed(1) + "%,", yPct.toFixed(1) + "%");
});


// === Keep content clear of the fixed legend ===
function adjustForLegend() {
  const legend = document.getElementById('legendBlock');
  const h = legend ? legend.offsetHeight : 0;
  const pad = (h + 8) + 'px';   // a little breathing room

  const mapViewport = document.getElementById('mapViewport');
  const sidebar     = document.getElementById('sidebar');

  if (mapViewport) mapViewport.style.paddingBottom = pad;
  if (sidebar)     sidebar.style.paddingBottom     = pad;
}

// Re-measure on resize
window.addEventListener('resize', adjustForLegend);

// ===== TEMP: prove pins layer renders even before data =====
window.addEventListener("DOMContentLoaded", () => {
  // make sure the spacing is set once the DOM exists
  adjustForLegend();

  const layer = document.getElementById("pinsLayer");
  if (!layer) return;
  // const test = makePin(50, 50, "#ff9800", "Forced test pin");
  // layer.appendChild(test);
});



