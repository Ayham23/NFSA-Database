// ---------- Firestore setup (shared team data) ----------
let fdb; // firestore instance
let firestoreReady = false;

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      firebase.initializeApp(firebaseConfig);
      fdb = firebase.firestore();
      // Allows the app to keep working offline and sync automatically once back online.
      fdb.enablePersistence({ synchronizeTabs: true }).catch(() => {
        // persistence can fail in some browser contexts (private mode, multiple tabs) — app still works online.
      });
      firestoreReady = true;
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function getInspectorName() {
  return localStorage.getItem('last_inspector') || 'غير معروف';
}

// ---------- Sync status tracking ----------
// A write's promise only resolves once Firestore confirms it reached the
// server — while offline it stays pending, which is exactly what we want
// to detect "saved locally, not yet synced to the team".
let pendingWrites = 0;

function trackWrite(promise) {
  pendingWrites++;
  updateSyncBadge();
  const settle = () => { pendingWrites--; updateSyncBadge(); };
  promise.then(settle, settle);
  return promise;
}

function updateSyncBadge() {
  const badge = document.getElementById('sync-badge');
  const iconEl = document.getElementById('sync-badge-icon');
  const textEl = document.getElementById('sync-badge-text');
  if (!badge) return;

  if (!navigator.onLine) {
    badge.className = 'sync-badge offline';
    iconEl.innerHTML = ICONS.offline;
    textEl.textContent = pendingWrites > 0
      ? `غير متصل — سيتم حفظ ${pendingWrites} تغييرات عند الاتصال`
      : 'غير متصل — سيتم الحفظ عند الاتصال';
  } else if (pendingWrites > 0) {
    badge.className = 'sync-badge syncing';
    iconEl.innerHTML = ICONS.sync;
    textEl.textContent = 'جارٍ المزامنة مع الفريق...';
  } else {
    badge.className = 'sync-badge hidden';
    return;
  }
  badge.classList.remove('hidden');
}

window.addEventListener('online', updateSyncBadge);
window.addEventListener('offline', updateSyncBadge);

// --- Danger flags: shared collection 'dangerFlags', doc id = facility_code ---
function setDangerFlag(code, flagged) {
  const ref = fdb.collection('dangerFlags').doc(code);
  const write = flagged
    ? ref.set({
        facility_code: code,
        date: new Date().toISOString().slice(0, 10),
        by: getInspectorName(),
      })
    : ref.delete();
  return trackWrite(write);
}

function getAllDangerFlagCodes() {
  return fdb.collection('dangerFlags').get().then(snap => snap.docs.map(d => d.id));
}

// Live updates: keeps every device's in-memory set in sync as flags change anywhere on the team.
function listenDangerFlags(onChange) {
  return fdb.collection('dangerFlags').onSnapshot(snap => {
    const codes = snap.docs.map(d => d.id);
    onChange(new Set(codes));
  });
}

// --- Follow-up dates: shared collection 'followups', doc id = facility_code ---
function setLastFollowup(code, dateStr) {
  const write = fdb.collection('followups').doc(code).set({
    facility_code: code,
    date: dateStr,
    by: getInspectorName(),
  });
  return trackWrite(write);
}

function getLastFollowup(code) {
  return fdb.collection('followups').doc(code).get().then(doc => (doc.exists ? doc.data() : null));
}

// --- Inspection visits: shared collection 'inspections' ---
function addInspection(record) {
  return trackWrite(fdb.collection('inspections').add(record).then(ref => ref.id));
}

function getAllInspections() {
  return fdb.collection('inspections').orderBy('created_at', 'desc').get()
    .then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

function getInspectionsForFacility(code) {
  return fdb.collection('inspections')
    .where('facility_code', '==', code)
    .orderBy('created_at', 'desc')
    .get()
    .then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

function getInspectionById(id) {
  return fdb.collection('inspections').doc(id).get()
    .then(doc => (doc.exists ? { id: doc.id, ...doc.data() } : null));
}

function updateInspection(record) {
  const { id, ...data } = record;
  return trackWrite(fdb.collection('inspections').doc(id).set(data));
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
let dangerFlaggedCodes = new Set();

// ---------- Screen elements ----------
const screens = {
  search: document.getElementById('screen-search'),
  detail: document.getElementById('screen-detail'),
  form: document.getElementById('screen-form'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
  currentScreen = name;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navMap = { search: 'nav-search' };
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
    const code = f['كود المنشأة'];
    const isDanger = dangerFlaggedCodes.has(code);
    const card = document.createElement('div');
    card.className = `facility-card risk-${riskClass(f['مستوى الخطورة'])}${isDanger ? ' is-danger' : ''}`;
    card.innerHTML = `
      ${isDanger ? `<div class="danger-strip">${icon('warning')} يوجد خطر داهم</div>` : ''}
      <div class="facility-card-row">
        <div class="facility-main">
          <p class="facility-name">${escapeHtml(f['اسم المنشأة'] || 'بدون اسم')}</p>
          <div class="facility-meta">
            <span>${icon('building')}${escapeHtml(f['مركز'] || '')}</span>
            <span>${escapeHtml(f['نشاط الفرع'] || '').split('-')[0] || ''}</span>
          </div>
        </div>
        <span class="facility-code">${escapeHtml(f['كود المنشأة'] || '')}</span>
      </div>
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
async function openDetail(code, push = true) {
  const f = byCode[code];
  if (!f) return;
  currentFacility = f;

  document.getElementById('detail-name').textContent = f['اسم المنشأة'] || 'بدون اسم';
  const badge = document.getElementById('detail-risk-badge');
  badge.innerHTML = `${icon('shield')} خطورة ${riskLabelAr(f['مستوى الخطورة'])}`;
  badge.className = `risk-badge badge-${riskClass(f['مستوى الخطورة'])}`;

  await renderFollowupBox(code);
  renderDangerState(code);

  const rows = [
    ['الكود', f['كود المنشأة'], null],
    ['المركز', f['مركز'], 'building'],
    ['العنوان', f['العنوان'], 'pin'],
    ['النشاط', f['نشاط الفرع'], null],
    ['المجموعة الغذائية', f['المجموعة الغذائية'], null],
    ['المسؤول', f['المرافقون'], null],
    ['الهاتف', f['الهاتف'], 'phone'],
    ['تاريخ آخر مأمورية', f['تاريخ المأمورية'], 'calendar'],
    ['سجل تجاري', f['سجل تجاري'], null],
    ['رقم السجل التجاري', f['رقم السجل التجاري'], null],
    ['وجود رخصة', f['وجود رخصه'], 'license'],
    ['رقم الرخصة', f['رقم الرخصه'], null],
  ];
  const grid = document.getElementById('detail-info-grid');
  grid.innerHTML = rows.map(([label, val, ic]) => `
    <div class="info-row">
      <div class="info-label">${ic ? icon(ic) : ''}${label}</div>
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
        <div class="log-date">${icon('calendar')}${l.date || ''}</div>
        <div class="log-notes">${escapeHtml(l.notes || 'بدون ملاحظات')}</div>
        <span class="log-tag">${icon('shield')} خطورة: ${riskLabelAr(l.risk_assessed)}</span>
        <span class="log-tag">${l.followup_status === 'closed' ? icon('check') + ' تمت المتابعة' : icon('clock') + ' متابعة مطلوبة'}</span>
      </div>
    `).join('');
  }

  showScreen('detail');
  if (push) {
    history.pushState({ screen: 'detail', code }, '', '#' + encodeURIComponent(code));
  }
}

document.getElementById('back-from-detail').addEventListener('click', () => history.back());
document.getElementById('btn-new-inspection').addEventListener('click', () => openForm(currentFacility['كود المنشأة']));

// ---------- Follow-up date tracking ----------
function formatDateAr(dateStr) {
  // dateStr is YYYY-MM-DD
  const [y, m, d] = dateStr.split('-');
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

async function renderFollowupBox(code) {
  const record = await getLastFollowup(code);
  const textEl = document.getElementById('followup-date-text');
  const infoEl = document.querySelector('#followup-box .followup-info');
  const btn = document.getElementById('btn-mark-followup');

  if (record && record.date) {
    textEl.textContent = `آخر متابعة: ${formatDateAr(record.date)}`;
    infoEl.classList.add('done');
    btn.textContent = 'تحديث المتابعة لليوم';
    btn.classList.add('done');
  } else {
    textEl.textContent = 'لم تتم متابعتها بعد';
    infoEl.classList.remove('done');
    btn.textContent = 'تم المتابعة اليوم';
    btn.classList.remove('done');
  }
}

document.getElementById('btn-mark-followup').addEventListener('click', async () => {
  if (!currentFacility) return;
  const code = currentFacility['كود المنشأة'];
  const today = new Date().toISOString().slice(0, 10);
  await setLastFollowup(code, today);
  await renderFollowupBox(code);
  toast('تم تسجيل المتابعة لهذا اليوم');
});

// ---------- Danger flag ----------
function renderDangerState(code) {
  const flagged = dangerFlaggedCodes.has(code);
  const note = document.getElementById('danger-note');
  const btn = document.getElementById('btn-toggle-danger');
  note.classList.toggle('hidden', !flagged);
  btn.textContent = flagged ? 'ازالة الخطر الداهم' : 'يوجد خطر داهم';
  btn.classList.toggle('flagged', flagged);
}

document.getElementById('btn-toggle-danger').addEventListener('click', async () => {
  if (!currentFacility) return;
  const code = currentFacility['كود المنشأة'];
  const flagged = dangerFlaggedCodes.has(code);
  await setDangerFlag(code, !flagged);
  if (flagged) {
    dangerFlaggedCodes.delete(code);
    toast('تم إزالة تنبيه الخطر الداهم');
  } else {
    dangerFlaggedCodes.add(code);
    toast('تم تسجيل خطر داهم لهذه المنشأة');
  }
  renderDangerState(code);
});

// ---------- Form screen (new inspection / follow-up) ----------
let selectedRisk = null;
let editingInspectionId = null;

function openForm(code, existing, push = true) {
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
  if (push) {
    history.pushState({ screen: 'form', code, existingId: existing ? existing.id : null }, '', '#' + encodeURIComponent(code) + '/visit');
  }
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

document.getElementById('back-from-form').addEventListener('click', () => history.back());

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
  await openDetail(currentFacility['كود المنشأة'], false);
});

document.getElementById('nav-search').addEventListener('click', () => {
  if (currentScreen !== 'search') {
    history.pushState({ screen: 'search' }, '', '#');
  }
  showScreen('search');
});

window.addEventListener('popstate', async (e) => {
  const state = e.state;
  if (!state || state.screen === 'search') {
    showScreen('search');
    return;
  }
  if (state.screen === 'detail') {
    await openDetail(state.code, false);
    return;
  }
  if (state.screen === 'form') {
    const f = byCode[state.code];
    if (!f) { showScreen('search'); return; }
    currentFacility = f;
    let existing = null;
    if (state.existingId) {
      existing = await getInspectionById(state.existingId);
    }
    openForm(state.code, existing, false);
  }
});

// ---------- Init ----------
function hideSplash() {
  const splash = document.getElementById('splash');
  if (splash) splash.classList.add('hidden');
}

(async function init() {
  history.replaceState({ screen: 'search' }, '', '#');
  const MIN_SPLASH_MS = 7000;
  const startTime = Date.now();
  const statusEl = document.getElementById('splash-status');
  try {
    if (statusEl) statusEl.textContent = 'جاري الاتصال بقاعدة البيانات المشتركة...';
    await openDB();
    if (statusEl) statusEl.textContent = `جاري تجهيز ${F.length.toLocaleString('ar-EG')} منشأة...`;
    populateFilters();
    runSearch();
    showScreen('search');
    updateSyncBadge();

    // Live sync: any device's danger-flag change reflects here automatically.
    listenDangerFlags((newSet) => {
      dangerFlaggedCodes = newSet;
      if (currentScreen === 'search') runSearch();
      if (currentScreen === 'detail' && currentFacility) {
        renderDangerState(currentFacility['كود المنشأة']);
      }
    });
  } finally {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(hideSplash, remaining);
  }
})();
