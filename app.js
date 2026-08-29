// ---------- IndexedDB setup ----------
const DB_NAME = 'nfsa_inspector_db';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('inspections')) {
        const store = _db.createObjectStore('inspections', { keyPath: 'id', autoIncrement: true });
        store.createIndex('facility_code', 'facility_code', { unique: false });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('followup_status', 'followup_status', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e);
  });
}

function addInspection(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('inspections', 'readwrite');
    const store = tx.objectStore('inspections');
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

function getAllInspections() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('inspections', 'readonly');
    const store = tx.objectStore('inspections');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = (e) => reject(e);
  });
}

function getInspectionsForFacility(code) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('inspections', 'readonly');
    const idx = tx.objectStore('inspections').index('facility_code');
    const req = idx.getAll(code);
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = (e) => reject(e);
  });
}

function updateInspection(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('inspections', 'readwrite');
    const store = tx.objectStore('inspections');
    const req = store.put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

// ---------- Data helpers ----------
const F = FACILITIES_DATA; // loaded via data.js
const byCode = {};
F.forEach(f => { byCode[f['كود المنشأة']] = f; });

const CENTERS = [...new Set(F.map(f => f['مركز']).filter(Boolean))].sort();

function riskClass(level) {
  if (level === 'High') return 'high';
  if (level === 'Medium') return 'medium';
  if (level === 'Low') return 'low';
  return 'medium';
}
function riskLabelAr(level) {
  if (level === 'High') return 'مرتفعة';
  if (level === 'Medium') return 'متوسطة';
  if (level === 'Low') return 'منخفضة';
  return level || '—';
}

// ---------- State ----------
let currentScreen = 'search';
let currentFacility = null;
let searchQuery = '';
let filterCenter = '';
let filterRisk = '';

// ---------- Screen elements ----------
const screens = {
  search: document.getElementById('screen-search'),
  detail: document.getElementById('screen-detail'),
  form: document.getElementById('screen-form'),
  followups: document.getElementById('screen-followups'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  currentScreen = name;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navMap = { search: 'nav-search', followups: 'nav-followups' };
  if (navMap[name]) document.getElementById(navMap[name]).classList.add('active');
  document.getElementById('app-screens').scrollTop = 0;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Search screen ----------
const listEl = document.getElementById('facility-list');
const countEl = document.getElementById('result-count');

function populateFilters() {
  const centerSel = document.getElementById('filter-center');
  CENTERS.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    centerSel.appendChild(opt);
  });
}

function runSearch() {
  const q = searchQuery.trim().toLowerCase();
  let results = F;
  if (filterCenter) results = results.filter(f => f['مركز'] === filterCenter);
  if (filterRisk) results = results.filter(f => f['مستوى الخطورة'] === filterRisk);
  if (q) {
    results = results.filter(f =>
      (f['اسم المنشأة'] || '').toLowerCase().includes(q) ||
      (f['كود المنشأة'] || '').toLowerCase().includes(q) ||
      (f['العنوان'] || '').toLowerCase().includes(q)
    );
  }
  renderList(results, !!q || !!filterCenter || !!filterRisk);
}

function renderList(results, isFiltered) {
  listEl.innerHTML = '';
  if (!isFiltered) {
    countEl.textContent = `إجمالي المنشآت: ${F.length.toLocaleString('ar-EG')} — ابحث بالاسم أو الكود أو العنوان`;
    return;
  }
  countEl.textContent = `${results.length.toLocaleString('ar-EG')} نتيجة`;
  if (results.length === 0) {
    listEl.innerHTML = `<div class="empty-state">لا توجد نتائج مطابقة</div>`;
    return;
  }
  const capped = results.slice(0, 200);
  const frag = document.createDocumentFragment();
  capped.forEach(f => {
    const card = document.createElement('div');
    card.className = 'facility-card';
    card.innerHTML = `
      <span class="risk-dot risk-${riskClass(f['مستوى الخطورة'])}"></span>
      <div class="facility-main">
        <p class="facility-name">${escapeHtml(f['اسم المنشأة'] || 'بدون اسم')}</p>
        <div class="facility-meta">
          <span>${escapeHtml(f['مركز'] || '')}</span>
          <span>${escapeHtml(f['نشاط الفرع'] || '').split('-')[0] || ''}</span>
        </div>
      </div>
      <span class="facility-code">${escapeHtml(f['كود المنشأة'] || '')}</span>
    `;
    card.addEventListener('click', () => openDetail(f['كود المنشأة']));
    frag.appendChild(card);
  });
  listEl.appendChild(frag);
  if (results.length > 200) {
    const more = document.createElement('div');
    more.className = 'empty-state';
    more.textContent = `و ${(results.length - 200).toLocaleString('ar-EG')} نتيجة أخرى — دقّق البحث لعرضها`;
    listEl.appendChild(more);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  runSearch();
});
document.getElementById('filter-center').addEventListener('change', (e) => {
  filterCenter = e.target.value;
  runSearch();
});
document.getElementById('filter-risk').addEventListener('change', (e) => {
  filterRisk = e.target.value;
  runSearch();
});

// ---------- Detail screen ----------
async function openDetail(code) {
  const f = byCode[code];
  if (!f) return;
  currentFacility = f;

  document.getElementById('detail-name').textContent = f['اسم المنشأة'] || 'بدون اسم';
  const badge = document.getElementById('detail-risk-badge');
  badge.textContent = `خطورة ${riskLabelAr(f['مستوى الخطورة'])}`;
  badge.className = `risk-badge badge-${riskClass(f['مستوى الخطورة'])}`;

  const rows = [
    ['الكود', f['كود المنشأة']],
    ['المركز', f['مركز']],
    ['العنوان', f['العنوان']],
    ['النشاط', f['نشاط الفرع']],
    ['المجموعة الغذائية', f['المجموعة الغذائية']],
    ['المسؤول', f['المرافقون']],
    ['الهاتف', f['الهاتف']],
    ['تاريخ آخر مأمورية', f['تاريخ المأمورية']],
    ['سجل تجاري', f['سجل تجاري']],
    ['رقم السجل التجاري', f['رقم السجل التجاري']],
    ['وجود رخصة', f['وجود رخصه']],
    ['رقم الرخصة', f['رقم الرخصه']],
  ];
  const grid = document.getElementById('detail-info-grid');
  grid.innerHTML = rows.map(([label, val]) => `
    <div class="info-row">
      <div class="info-label">${label}</div>
      <div class="info-value ${!val ? 'empty' : ''}">${escapeHtml(val || 'غير مسجل')}</div>
    </div>
  `).join('');

  // load past inspections for this facility
  const logs = await getInspectionsForFacility(code);
  const logWrap = document.getElementById('detail-logs');
  if (logs.length === 0) {
    logWrap.innerHTML = `<div class="empty-state" style="padding:24px 8px;">لا توجد زيارات مسجّلة على الجهاز بعد</div>`;
  } else {
    logWrap.innerHTML = logs.map(l => `
      <div class="log-card">
        <div class="log-date">${l.date || ''}</div>
        <div class="log-notes">${escapeHtml(l.notes || 'بدون ملاحظات')}</div>
        <span class="log-tag">خطورة: ${riskLabelAr(l.risk_assessed)}</span>
        <span class="log-tag">${l.followup_status === 'closed' ? 'تمت المتابعة' : 'متابعة مطلوبة'}</span>
      </div>
    `).join('');
  }

  showScreen('detail');
}

document.getElementById('back-from-detail').addEventListener('click', () => showScreen('search'));
document.getElementById('btn-new-inspection').addEventListener('click', () => openForm(currentFacility['كود المنشأة']));

// ---------- Form screen (new inspection / follow-up) ----------
let selectedRisk = null;
let editingInspectionId = null;

function openForm(code, existing) {
  const f = byCode[code];
  document.getElementById('form-facility-name').textContent = f ? f['اسم المنشأة'] : code;
  document.getElementById('form-facility-code').textContent = code;
  document.getElementById('inspector-name').value = existing ? existing.inspector : (localStorage.getItem('last_inspector') || '');
  document.getElementById('inspection-date').value = existing ? existing.date : new Date().toISOString().slice(0,10);
  document.getElementById('inspection-notes').value = existing ? existing.notes : '';
  document.getElementById('followup-status').value = existing ? existing.followup_status : 'open';
  selectedRisk = existing ? existing.risk_assessed : f['مستوى الخطورة'];
  editingInspectionId = existing ? existing.id : null;
  document.getElementById('form-title').textContent = existing ? 'تعديل الزيارة' : 'تسجيل زيارة جديدة';
  renderRiskOptions();
  showScreen('form');
}

function renderRiskOptions() {
  const wrap = document.getElementById('risk-options');
  const options = [['High','مرتفعة','high'],['Medium','متوسطة','medium'],['Low','منخفضة','low']];
  wrap.innerHTML = options.map(([val,label,cls]) => `
    <div class="radio-option ${selectedRisk===val?'selected opt-'+cls:''}" data-val="${val}" data-cls="${cls}">${label}</div>
  `).join('');
  wrap.querySelectorAll('.radio-option').forEach(el => {
    el.addEventListener('click', () => {
      selectedRisk = el.dataset.val;
      renderRiskOptions();
    });
  });
}

document.getElementById('back-from-form').addEventListener('click', () => showScreen('detail'));

document.getElementById('inspection-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inspector = document.getElementById('inspector-name').value.trim();
  if (!inspector) { toast('برجاء إدخال اسم القائم بالتفتيش'); return; }
  localStorage.setItem('last_inspector', inspector);

  const record = {
    facility_code: currentFacility['كود المنشأة'],
    facility_name: currentFacility['اسم المنشأة'],
    center: currentFacility['مركز'],
    date: document.getElementById('inspection-date').value,
    inspector: inspector,
    risk_assessed: selectedRisk,
    notes: document.getElementById('inspection-notes').value.trim(),
    followup_status: document.getElementById('followup-status').value,
    created_at: new Date().toISOString(),
  };

  if (editingInspectionId) {
    record.id = editingInspectionId;
    await updateInspection(record);
    toast('تم تحديث الزيارة');
  } else {
    await addInspection(record);
    toast('تم حفظ الزيارة');
  }
  await openDetail(currentFacility['كود المنشأة']);
});

// ---------- Follow-ups screen ----------
async function renderFollowups() {
  const all = await getAllInspections();
  const open = all.filter(l => l.followup_status !== 'closed');
  document.getElementById('stat-total').textContent = all.length.toLocaleString('ar-EG');
  document.getElementById('stat-open').textContent = open.length.toLocaleString('ar-EG');
  document.getElementById('stat-closed').textContent = (all.length - open.length).toLocaleString('ar-EG');

  const wrap = document.getElementById('followups-list');
  if (all.length === 0) {
    wrap.innerHTML = `<div class="empty-state">لم تُسجَّل أي زيارات على هذا الجهاز بعد.<br>ابحث عن منشأة وسجّل زيارة لتظهر هنا.</div>`;
    return;
  }
  wrap.innerHTML = all.map(l => `
    <div class="log-card" data-id="${l.id}">
      <p class="facility-name" style="margin-bottom:4px;">${escapeHtml(l.facility_name || l.facility_code)}</p>
      <div class="log-date">${l.center || ''} • ${l.date || ''} • ${escapeHtml(l.inspector || '')}</div>
      <div class="log-notes">${escapeHtml(l.notes || 'بدون ملاحظات')}</div>
      <span class="log-tag">خطورة: ${riskLabelAr(l.risk_assessed)}</span>
      <span class="log-tag">${l.followup_status === 'closed' ? '✓ تمت المتابعة' : 'متابعة مطلوبة'}</span>
    </div>
  `).join('');
  wrap.querySelectorAll('.log-card').forEach(el => {
    el.addEventListener('click', async () => {
      const id = Number(el.dataset.id);
      const rec = all.find(x => x.id === id);
      const f = byCode[rec.facility_code];
      if (f) {
        currentFacility = f;
        openForm(rec.facility_code, rec);
      }
    });
  });
}

document.getElementById('nav-search').addEventListener('click', () => showScreen('search'));
document.getElementById('nav-followups').addEventListener('click', async () => {
  await renderFollowups();
  showScreen('followups');
});

// ---------- Init ----------
function hideSplash() {
  const splash = document.getElementById('splash');
  if (splash) splash.classList.add('hidden');
}

(async function init() {
  const statusEl = document.getElementById('splash-status');
  try {
    if (statusEl) statusEl.textContent = 'جاري فتح قاعدة البيانات...';
    await openDB();
    if (statusEl) statusEl.textContent = `جاري تجهيز ${F.length.toLocaleString('ar-EG')} منشأة...`;
    populateFilters();
    runSearch();
    showScreen('search');
  } finally {
    // small delay so the splash doesn't just flash on fast loads
    setTimeout(hideSplash, 350);
  }
})();
