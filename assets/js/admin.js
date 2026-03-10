/* =============================================
   ADMIN PAGE — ODD PARTY
   ============================================= */
(function () {
  'use strict';

  const API_BASE = document.querySelector('meta[name="api-base-url"]')?.content || '';
  const PAGE_SIZE = 20;

  let token = localStorage.getItem('admin_token') || '';
  let allApplications = [];
  let filteredApplications = [];
  let currentPage = 1;

  /* --- Helpers --- */
  function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(API_BASE + path, { ...opts, headers });
  }

  function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  }

  /* =============================================
     AUTH
     ============================================= */
  const overlay = document.getElementById('loginOverlay');
  const loginBtn = document.getElementById('loginBtn');
  const loginInput = document.getElementById('loginToken');
  const loginError = document.getElementById('loginError');
  const logoutBtn = document.getElementById('adminLogoutBtn');

  async function checkAuth() {
    if (!token) { showLogin(); return; }
    try {
      const res = await api('/api/auth/check');
      if (res.ok) { hideLogin(); loadData(); }
      else { token = ''; localStorage.removeItem('admin_token'); showLogin(); }
    } catch { showLogin(); }
  }

  function showLogin() { overlay.style.display = 'flex'; }
  function hideLogin() { overlay.style.display = 'none'; }

  loginBtn.addEventListener('click', doLogin);
  loginInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    const val = loginInput.value.trim();
    if (!val) return;
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: val }),
      });
      if (res.ok) {
        const data = await res.json();
        token = data.token;
        localStorage.setItem('admin_token', token);
        loginError.style.display = 'none';
        hideLogin();
        loadData();
      } else {
        loginError.style.display = 'block';
      }
    } catch {
      loginError.textContent = '서버 연결 실패';
      loginError.style.display = 'block';
    }
  }

  logoutBtn.addEventListener('click', () => {
    token = '';
    localStorage.removeItem('admin_token');
    location.reload();
  });

  /* =============================================
     LOAD DATA
     ============================================= */
  async function loadData() {
    try {
      const res = await api('/api/applications');
      if (res.status === 401) { showLogin(); return; }
      const data = await res.json();
      allApplications = data.applications || [];
      document.getElementById('todayCount').textContent = data.stats?.todayCount ?? '-';
      document.getElementById('totalCount').textContent = data.stats?.totalCount ?? '-';
      document.getElementById('couponCount').textContent = data.stats?.couponCount ?? '-';
      applyFilters();
    } catch (err) {
      document.getElementById('applicationsTableBody').innerHTML =
        '<tr><td colspan="9" style="text-align:center;color:var(--accent)">데이터 로드 실패</td></tr>';
    }
  }

  /* =============================================
     FILTERS
     ============================================= */
  const searchInput = document.getElementById('search');
  const statusFilter = document.getElementById('statusFilter');
  const locationFilter = document.getElementById('locationFilter');

  [searchInput, statusFilter, locationFilter].forEach(el => {
    el.addEventListener('input', () => { currentPage = 1; applyFilters(); });
    el.addEventListener('change', () => { currentPage = 1; applyFilters(); });
  });

  function applyFilters() {
    const q = searchInput.value.trim().toLowerCase();
    const status = statusFilter.value;
    const loc = locationFilter.value;

    filteredApplications = allApplications.filter(app => {
      if (q && !app.name.toLowerCase().includes(q) && !app.phone.includes(q)) return false;
      if (status !== 'all' && app.status !== status) return false;
      if (loc !== 'all' && !app.branch.includes(loc)) return false;
      return true;
    });

    renderTable();
    renderPagination();
  }

  /* =============================================
     TABLE RENDER WITH PAGINATION
     ============================================= */
  function renderTable() {
    const tbody = document.getElementById('applicationsTableBody');
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filteredApplications.slice(start, start + PAGE_SIZE);

    if (pageItems.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:var(--sp-2xl)">데이터가 없습니다.</td></tr>';
      return;
    }

    tbody.innerHTML = pageItems.map(app => `
      <tr>
        <td>${fmtDate(app.createdAt)}</td>
        <td><strong>${esc(app.name)}</strong> (${app.age})</td>
        <td>${esc(app.phone)}</td>
        <td>${esc(app.branch)} / ${app.priceText}</td>
        <td>${esc(app.partyDate)}</td>
        <td>${app.coupon ? esc(app.coupon) : '<span style="color:var(--muted)">-</span>'}</td>
        <td>
          <select data-id="${app.id}" data-field="status">
            ${['입금대기','입금완료','보류','취소','환불'].map(s =>
              `<option value="${s}"${s === app.status ? ' selected' : ''}>${s}</option>`
            ).join('')}
          </select>
        </td>
        <td><input type="text" data-id="${app.id}" data-field="admin_note" value="${esc(app.adminNote)}" /></td>
        <td style="color:var(--muted);font-size:var(--fs-xs)">${app.id}</td>
      </tr>
    `).join('');

    // Attach inline edit handlers
    tbody.querySelectorAll('select[data-field="status"]').forEach(sel => {
      sel.addEventListener('change', () => patchApp(sel.dataset.id, { status: sel.value }));
    });

    let debounceTimers = {};
    tbody.querySelectorAll('input[data-field="admin_note"]').forEach(input => {
      input.addEventListener('input', () => {
        const id = input.dataset.id;
        clearTimeout(debounceTimers[id]);
        debounceTimers[id] = setTimeout(() => patchApp(id, { admin_note: input.value }), 800);
      });
    });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  async function patchApp(id, updates) {
    try {
      await api(`/api/applications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
    } catch { /* silent */ }
  }

  /* =============================================
     PAGINATION
     ============================================= */
  function renderPagination() {
    const container = document.getElementById('pagination');
    const totalPages = Math.max(1, Math.ceil(filteredApplications.length / PAGE_SIZE));

    if (totalPages <= 1) { container.innerHTML = ''; return; }

    let html = '';
    html += `<button ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">&laquo; 이전</button>`;

    const maxButtons = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);
    if (endPage - startPage + 1 < maxButtons) startPage = Math.max(1, endPage - maxButtons + 1);

    for (let p = startPage; p <= endPage; p++) {
      html += `<button class="${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }

    html += `<button ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">다음 &raquo;</button>`;
    html += `<span class="page-info">${filteredApplications.length}건 중 ${(currentPage-1)*PAGE_SIZE+1}-${Math.min(currentPage*PAGE_SIZE, filteredApplications.length)}</span>`;

    container.innerHTML = html;
    container.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p >= 1 && p <= totalPages) {
          currentPage = p;
          renderTable();
          renderPagination();
          document.querySelector('.table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  /* =============================================
     CSV / BACKUP EXPORT
     ============================================= */
  document.getElementById('exportCsvBtn').addEventListener('click', async () => {
    try {
      const res = await api('/api/applications/export/csv');
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'applications.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch { alert('CSV 다운로드 실패'); }
  });

  document.getElementById('exportBackupBtn').addEventListener('click', async () => {
    try {
      const res = await api('/api/backup');
      if (!res.ok) return;
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { alert('백업 다운로드 실패'); }
  });

  /* =============================================
     SITE CONTENT EDITOR
     ============================================= */
  const CONTENT_DEFAULTS = {
    'hero-title': '낯선 사람들이 만나는 밤',
    'hero-sub': '20~30대 소셜 파티 · ODD PARTY',
    'intro-title': 'ODD PARTY란?',
    'cta-title': '자리가 빠르게 마감됩니다',
    'cta-sub': '매 회차 소수 정예로 진행되어 자리가 빠르게 찹니다.\n친구에게 공유하고 함께 신청해 보세요!',
  };

  const contentForm = document.getElementById('siteContentForm');
  const contentSections = document.getElementById('contentEditorSections');
  const contentStatus = document.getElementById('contentSaveStatus');

  async function loadSiteContent() {
    try {
      const res = await fetch(API_BASE + '/api/site-content');
      const data = await res.json();
      const content = data.content || {};
      renderContentEditor(content);
    } catch { /* silent */ }
  }

  function renderContentEditor(content) {
    const merged = { ...CONTENT_DEFAULTS, ...content };
    contentSections.innerHTML = Object.entries(merged).map(([key, val]) => `
      <div class="editor-field">
        <label for="content-${key}">${key}</label>
        <textarea id="content-${key}" data-key="${key}" rows="2">${esc(val)}</textarea>
      </div>
    `).join('');
  }

  contentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = contentSections.querySelectorAll('[data-key]');
    const content = {};
    fields.forEach(f => { content[f.dataset.key] = f.value; });
    try {
      const res = await api('/api/site-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        contentStatus.textContent = '저장 완료!';
        contentStatus.style.color = '#22c55e';
      } else {
        contentStatus.textContent = '저장 실패';
        contentStatus.style.color = 'var(--accent)';
      }
    } catch {
      contentStatus.textContent = '서버 연결 실패';
      contentStatus.style.color = 'var(--accent)';
    }
  });

  document.getElementById('resetSiteContent').addEventListener('click', () => {
    if (confirm('모든 텍스트를 초기값으로 복원하시겠습니까?')) {
      renderContentEditor({});
      contentStatus.textContent = '초기값으로 복원되었습니다. 저장을 눌러 반영하세요.';
      contentStatus.style.color = 'var(--primary)';
    }
  });

  /* =============================================
     PASSWORD CHANGE
     ============================================= */
  const pwForm = document.getElementById('pwChangeForm');
  const pwStatus = document.getElementById('pwStatus');

  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPw = document.getElementById('pw-current').value;
    const newPw = document.getElementById('pw-new').value;
    const confirmPw = document.getElementById('pw-confirm').value;

    pwStatus.className = 'pw-status';
    pwStatus.textContent = '';

    if (!currentPw || !newPw) {
      pwStatus.className = 'pw-status error';
      pwStatus.textContent = '모든 필드를 입력해 주세요.';
      return;
    }
    if (newPw.length < 6) {
      pwStatus.className = 'pw-status error';
      pwStatus.textContent = '새 비밀번호는 6자 이상이어야 합니다.';
      return;
    }
    if (newPw !== confirmPw) {
      pwStatus.className = 'pw-status error';
      pwStatus.textContent = '새 비밀번호가 일치하지 않습니다.';
      return;
    }

    try {
      const res = await api('/api/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (res.ok) {
        pwStatus.className = 'pw-status success';
        pwStatus.textContent = '비밀번호가 변경되었습니다.';
        // Update stored token
        token = newPw;
        localStorage.setItem('admin_token', token);
        pwForm.reset();
      } else {
        pwStatus.className = 'pw-status error';
        pwStatus.textContent = data.error || '변경 실패';
      }
    } catch {
      pwStatus.className = 'pw-status error';
      pwStatus.textContent = '서버 연결 실패';
    }
  });

  /* =============================================
     INIT
     ============================================= */
  checkAuth();
  loadSiteContent();
})();
