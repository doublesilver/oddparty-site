    /* ============================================================
       CONFIG
    ============================================================ */
    var API_BASE = 'https://oddparty-api-production.up.railway.app';
    var FALLBACK_PW = 'oddparty2026';  // offline fallback
    var LS_TOKEN = 'admin_token';
    var PAGE_SIZE = 20;

    /* ============================================================
       STATE
    ============================================================ */
    var state = {
      token: localStorage.getItem(LS_TOKEN) || '',
      apps: [],
      filtered: [],
      page: 1,
      search: '',
      filterStatus: '',
      filterBranch: '',
      filterDate: '',
      filterDateFrom: '',
      filterDateTo: '',
      debounceTimer: null,
      noteTimers: {}
    };

    /* ============================================================
       UTILS
    ============================================================ */
    function esc(str) {
      var d = document.createElement('div');
      d.textContent = String(str == null ? '' : str);
      return d.innerHTML;
    }

    function authHeaders() {
      return { 'Authorization': 'Bearer ' + state.token, 'Content-Type': 'application/json' };
    }

    function showToast(msg, isErr) {
      var el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast' + (isErr ? ' err' : '');
      el.classList.add('show');
      clearTimeout(el._timer);
      el._timer = setTimeout(function() { el.classList.remove('show'); }, 2800);
    }

    function formatDate(iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d)) return iso;
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    /* ============================================================
       INIT
    ============================================================ */
    (function init() {
      fixLogos();
      bindNav();
      bindDashboard();
      bindContent();
      bindDiscount();
      bindSettings();
      document.getElementById('login-form').addEventListener('submit', handleLogin);
      document.getElementById('logout-btn').addEventListener('click', handleLogout);

      if (state.token) {
        /* 토큰이 있으면 먼저 shell 표시 후 비동기로 인증 확인 */
        showShell();
        /* URL hash에서 이전 섹션 복원 */
        var hashSection = location.hash.replace('#', '');
        if (hashSection === 'sec-pricing') hashSection = 'sec-branch';
        if (hashSection && document.getElementById(hashSection)) {
          switchSection(hashSection);
        }
        checkAuth();
      }
    })();

    /* Fix logos for dark/light mode */
    function fixLogos() {
      var darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
      function applyLogos(isDark) {
        document.querySelectorAll('.logo-light').forEach(function(el) { el.style.display = isDark ? 'block' : 'none'; });
        document.querySelectorAll('.logo-dark').forEach(function(el)  { el.style.display = isDark ? 'none'  : 'block'; });
      }
      applyLogos(darkMQ.matches);
      darkMQ.addEventListener('change', function(e) { applyLogos(e.matches); });
    }

    /* ============================================================
       AUTH
    ============================================================ */
    function handleLogin(e) {
      e.preventDefault();
      var pw = document.getElementById('login-pw').value.trim();
      var errEl = document.getElementById('login-error');
      errEl.classList.remove('visible');

      fetch(API_BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pw })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('auth_fail');
        return r.json();
      })
      .then(function(data) {
        state.token = data.token || pw;
        localStorage.setItem(LS_TOKEN, state.token);
        errEl.classList.remove('visible');
        document.getElementById('login-pw').value = '';
        showShell();
        loadDashboard();
      })
      .catch(function() {
        // Fallback: if no backend, check against default password
        if (pw === FALLBACK_PW) {
          state.token = pw;
          localStorage.setItem(LS_TOKEN, state.token);
          errEl.classList.remove('visible');
          document.getElementById('login-pw').value = '';
          showShell();
          loadDashboard();
          return;
        }
        errEl.classList.add('visible');
        document.getElementById('login-pw').value = '';
        document.getElementById('login-pw').focus();
      });
    }

    function checkAuth() {
      fetch(API_BASE + '/api/auth/check', {
        headers: { 'Authorization': 'Bearer ' + state.token }
      })
      .then(function(r) {
        if (!r.ok) throw new Error('invalid');
        showShell();
        loadDashboard();
      })
      .catch(function() {
        // Fallback: if no backend, accept stored fallback password
        if (state.token === FALLBACK_PW) {
          showShell();
          loadDashboard();
          return;
        }
        state.token = '';
        localStorage.removeItem(LS_TOKEN);
      });
    }

    function handleLogout() {
      state.token = '';
      localStorage.removeItem(LS_TOKEN);
      document.getElementById('admin-shell').classList.remove('visible');
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('login-pw').value = '';
    }

    function showShell() {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('admin-shell').classList.add('visible');
    }

    /* ============================================================
       NAVIGATION
    ============================================================ */
    function bindNav() {
      document.querySelectorAll('[data-target]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          switchSection(btn.getAttribute('data-target'));
        });
      });
    }

    function toggleHelp(id) {
      var panel = document.getElementById(id);
      if (panel) panel.classList.toggle('visible');
    }

    function switchSection(targetId) {
      document.querySelectorAll('.admin-section').forEach(function(s) { s.classList.remove('active'); });
      document.querySelectorAll('.sidebar-nav-btn, .admin-tab-btn, .bottom-nav-btn').forEach(function(b) { b.classList.remove('active'); });
      document.getElementById(targetId).classList.add('active');
      /* URL hash에 현재 섹션 저장 (새로고침 시 복원) */
      history.replaceState(null, '', '#' + targetId);
      document.querySelectorAll('[data-target="' + targetId + '"]').forEach(function(b) { b.classList.add('active'); });

      var saveBar = document.getElementById('save-bar');
      saveBar.style.display = targetId === 'sec-content' ? 'flex' : 'none';

      if (targetId === 'sec-dashboard') loadDashboard();
      if (targetId === 'sec-capacity') loadCapacity();
      if (targetId === 'sec-branch')   { loadPricing(); setTimeout(updatePricePreview, 300); }
      if (targetId === 'sec-faq')      loadFaqList();
      if (targetId === 'sec-content')  { loadSiteContent(); loadAccountIntoIframes(); }
      if (targetId === 'sec-settings') { loadAccountInfo(); loadSettingsContent(); }
    }

    /* ============================================================
       DASHBOARD
    ============================================================ */
    function bindDashboard() {
      document.getElementById('app-search').addEventListener('input', function() {
        state.search = this.value;
        state.page = 1;
        applyFilters();
      });
      document.getElementById('filter-status').addEventListener('change', function() {
        state.filterStatus = this.value;
        state.page = 1;
        applyFilters();
      });
      document.getElementById('filter-branch').addEventListener('change', function() {
        state.filterBranch = this.value;
        state.page = 1;
        applyFilters();
      });
      document.getElementById('filter-date').addEventListener('change', function() {
        state.filterDate = this.value;
        state.page = 1;
        applyFilters();
      });
      document.getElementById('filter-date-from').addEventListener('change', function() {
        state.filterDateFrom = this.value;
        state.page = 1;
        applyFilters();
      });
      document.getElementById('filter-date-to').addEventListener('change', function() {
        state.filterDateTo = this.value;
        state.page = 1;
        applyFilters();
      });
      document.getElementById('btn-refresh').addEventListener('click', loadDashboard);
      document.getElementById('btn-export-csv').addEventListener('click', exportCsv);
      document.getElementById('btn-backup').addEventListener('click', downloadBackup);
    }

    function loadDashboard() {
      fetch(API_BASE + '/api/applications', { headers: { 'Authorization': 'Bearer ' + state.token } })
      .then(function(r) {
        if (r.status === 401) { handleLogout(); throw new Error('unauth'); }
        if (!r.ok) throw new Error('fetch_fail');
        return r.json();
      })
      .then(function(data) {
        var apps = data.applications || [];
        var stats = data.stats || {};
        state.apps = apps;

        // Stats
        document.getElementById('stat-total').textContent  = stats.totalCount != null ? stats.totalCount : apps.length;
        document.getElementById('stat-today').textContent  = stats.todayCount != null ? stats.todayCount : '—';
        document.getElementById('stat-coupon').textContent = stats.couponCount != null ? stats.couponCount : '—';

        // Days breakdown (dynamic)
        var dayCounts = {};
        apps.forEach(function(a) {
          if (a.partyDate) {
            var day = String(a.partyDate);
            if (!dayCounts[day]) dayCounts[day] = 0;
            dayCounts[day]++;
          }
        });
        document.getElementById('stat-days').textContent = '';
        var dayParts = [];
        Object.keys(dayCounts).forEach(function(d) {
          dayParts.push(d + ' ' + dayCounts[d]);
        });
        document.getElementById('stat-days-sub').textContent = dayParts.join(' / ') || '—';

        // Populate date filter dynamically from actual data
        var dateSet = {};
        apps.forEach(function(a) {
          if (a.partyDate) dateSet[a.partyDate] = true;
        });
        var dateSelect = document.getElementById('filter-date');
        var currentVal = dateSelect.value;
        dateSelect.innerHTML = '<option value="">전체 날짜</option>';
        Object.keys(dateSet).sort().forEach(function(d) {
          dateSelect.innerHTML += '<option value="' + esc(d) + '"' + (currentVal === d ? ' selected' : '') + '>' + esc(d) + '</option>';
        });

        // Populate branch filter dynamically from actual data
        var branchSet = {};
        apps.forEach(function(a) {
          if (a.branch) branchSet[a.branch] = true;
        });
        var branchSelect = document.getElementById('filter-branch');
        var currentBranch = branchSelect.value;
        branchSelect.innerHTML = '<option value="">전체 지점</option>';
        Object.keys(branchSet).sort().forEach(function(b) {
          branchSelect.innerHTML += '<option value="' + esc(b) + '"' + (currentBranch === b ? ' selected' : '') + '>' + esc(b) + '</option>';
        });

        state.page = 1;
        applyFilters();
        updateRevenueStats();
      })
      .catch(function(err) {
        if (err.message !== 'unauth') {
          document.getElementById('app-tbody').innerHTML = '<tr class="loading-row"><td colspan="10">데이터를 불러오지 못했습니다.</td></tr>';
        }
      });
    }

    function applyFilters() {
      var q = state.search.toLowerCase();
      state.filtered = state.apps.filter(function(a) {
        if (q && (String(a.name || '').toLowerCase().indexOf(q) === -1) &&
                 (String(a.phone || '').toLowerCase().indexOf(q) === -1)) return false;
        if (state.filterStatus && a.status !== state.filterStatus) return false;
        if (state.filterBranch && String(a.branch || '').indexOf(state.filterBranch) === -1) return false;
        if (state.filterDate && String(a.partyDate || '').indexOf(state.filterDate) === -1) return false;
        if (state.filterDateFrom && a.createdAt) {
          var d = new Date(a.createdAt);
          if (d < new Date(state.filterDateFrom)) return false;
        }
        if (state.filterDateTo && a.createdAt) {
          var d2 = new Date(a.createdAt);
          var to = new Date(state.filterDateTo);
          to.setHours(23, 59, 59, 999);
          if (d2 > to) return false;
        }
        return true;
      });
      renderTable();
      renderPagination();
    }

    function renderTable() {
      var tbody = document.getElementById('app-tbody');
      var start = (state.page - 1) * PAGE_SIZE;
      var slice = state.filtered.slice(start, start + PAGE_SIZE);

      if (slice.length === 0) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="10">신청 내역이 없습니다.</td></tr>';
        return;
      }

      var html = '';
      slice.forEach(function(a) {
        var statusOpts = ['입금대기', '입금완료', '보류', '취소', '환불'];
        var statusHtml = '<select class="status-select" data-status="' + esc(a.status) + '" data-id="' + esc(a.id) + '">';
        statusOpts.forEach(function(s) {
          statusHtml += '<option value="' + esc(s) + '"' + (a.status === s ? ' selected' : '') + '>' + esc(s) + '</option>';
        });
        statusHtml += '</select>';

        html += '<tr data-id="' + esc(a.id) + '">' +
          '<td class="cell-check"><input type="checkbox" class="row-check" data-id="' + esc(a.id) + '" /></td>' +
          '<td>' + esc(formatDate(a.createdAt)) + '</td>' +
          '<td class="cell-name">' + esc(a.name) + (a.age ? ' <span style="color:var(--muted);font-weight:400;">(' + esc(a.age) + ')</span>' : '') + '</td>' +
          '<td class="cell-phone">' + esc(a.phone) + '</td>' +
          '<td>' + esc(a.branch || '') + (a.priceText ? ' / ' + esc(a.priceText) : '') + '</td>' +
          '<td>' + esc(a.partyDate || '—') + '</td>' +
          '<td class="cell-coupon">' + esc(a.coupon || '') + '</td>' +
          '<td>' + (a.instagram ? '@' + esc(a.instagram) : '—') + '</td>' +
          '<td>' + statusHtml + '</td>' +
          '<td><input class="note-input" type="text" value="' + esc(a.adminNote || '') + '" data-id="' + esc(a.id) + '" placeholder="메모…" /></td>' +
          '<td class="cell-id">' + esc(a.id) + '</td>' +
        '</tr>';
      });
      tbody.innerHTML = html;

      // Bind row click for detail modal
      tbody.querySelectorAll('tr').forEach(function(tr, idx) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', function(e) {
          // Don't open modal if clicking on select, input, or button
          if (e.target.closest('select, input, button')) return;
          var app = slice[idx];
          if (app) openDetailModal(app);
        });
      });

      // Bind status selects
      tbody.querySelectorAll('.status-select').forEach(function(sel) {
        sel.addEventListener('change', function() {
          var id = this.getAttribute('data-id');
          var newStatus = this.value;
          this.setAttribute('data-status', newStatus);
          patchApplication(id, { status: newStatus });
        });
      });

      // Bind note inputs (debounced)
      tbody.querySelectorAll('.note-input').forEach(function(inp) {
        inp.addEventListener('input', function() {
          var id = this.getAttribute('data-id');
          var val = this.value;
          clearTimeout(state.noteTimers[id]);
          state.noteTimers[id] = setTimeout(function() {
            patchApplication(id, { admin_note: val });
          }, 800);
        });
      });
    }

    function renderPagination() {
      var pg = document.getElementById('pagination');
      var total = state.filtered.length;
      var pages = Math.ceil(total / PAGE_SIZE);
      if (pages <= 1) { pg.innerHTML = ''; return; }

      var html = '<button class="page-btn" id="pg-prev" ' + (state.page <= 1 ? 'disabled' : '') + '>이전</button>';
      var start = Math.max(1, state.page - 2);
      var end   = Math.min(pages, state.page + 2);
      for (var i = start; i <= end; i++) {
        html += '<button class="page-btn' + (i === state.page ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
      }
      html += '<span class="page-info">' + state.page + ' / ' + pages + '</span>';
      html += '<button class="page-btn" id="pg-next" ' + (state.page >= pages ? 'disabled' : '') + '>다음</button>';
      pg.innerHTML = html;

      pg.querySelector('#pg-prev').addEventListener('click', function() {
        if (state.page > 1) { state.page--; renderTable(); renderPagination(); }
      });
      pg.querySelector('#pg-next').addEventListener('click', function() {
        if (state.page < pages) { state.page++; renderTable(); renderPagination(); }
      });
      pg.querySelectorAll('[data-page]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          state.page = parseInt(this.getAttribute('data-page'), 10);
          renderTable();
          renderPagination();
        });
      });
    }

    /* ============================================================
       BULK DELETE
    ============================================================ */
    function getCheckedIds() {
      var ids = [];
      document.querySelectorAll('.row-check:checked').forEach(function(cb) {
        ids.push(cb.getAttribute('data-id'));
      });
      return ids;
    }

    function updateBulkBar() {
      var ids = getCheckedIds();
      var bar = document.getElementById('bulk-actions-bar');
      document.getElementById('bulk-count').textContent = ids.length;
      bar.classList.toggle('visible', ids.length > 0);
    }

    document.getElementById('check-all').addEventListener('change', function() {
      var checked = this.checked;
      document.querySelectorAll('.row-check').forEach(function(cb) { cb.checked = checked; });
      updateBulkBar();
    });

    document.addEventListener('change', function(e) {
      if (e.target.classList.contains('row-check')) {
        updateBulkBar();
        // Update check-all state
        var all = document.querySelectorAll('.row-check');
        var allChecked = document.querySelectorAll('.row-check:checked');
        document.getElementById('check-all').checked = all.length > 0 && all.length === allChecked.length;
      }
    });

    document.getElementById('bulk-delete-btn').addEventListener('click', function() {
      var ids = getCheckedIds();
      if (ids.length === 0) return;
      if (!confirm(ids.length + '명의 신청을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;

      fetch(API_BASE + '/api/admin/applications/bulk-delete', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ids: ids })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('bulk_delete_fail');
        return r.json();
      })
      .then(function(data) {
        showToast(data.deleted_count + '건이 삭제되었습니다.');
        document.getElementById('check-all').checked = false;
        updateBulkBar();
        loadDashboard();
      })
      .catch(function() { showToast('삭제에 실패했습니다.', true); });
    });

    document.getElementById('bulk-cancel-btn').addEventListener('click', function() {
      document.getElementById('check-all').checked = false;
      document.querySelectorAll('.row-check').forEach(function(cb) { cb.checked = false; });
      updateBulkBar();
    });

    function patchApplication(id, body) {
      fetch(API_BASE + '/api/applications/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(body)
      })
      .then(function(r) {
        if (!r.ok) throw new Error('patch_fail');
        showToast('저장되었습니다.');
        // Sync local state
        state.apps.forEach(function(a) {
          if (a.id == id) {
            if (body.status !== undefined) a.status = body.status;
            if (body.admin_note !== undefined) a.adminNote = body.admin_note;
          }
        });
      })
      .catch(function() {
        showToast('저장 실패', true);
      });
    }

    function exportCsv() {
      var url = API_BASE + '/api/applications/export/csv';
      var a = document.createElement('a');
      a.href = url;
      a.setAttribute('download', '');
      // Pass token via query param as fallback since download link can't set headers
      a.href = url + '?token=' + encodeURIComponent(state.token);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function downloadBackup() {
      var url = API_BASE + '/api/backup?token=' + encodeURIComponent(state.token);
      var a = document.createElement('a');
      a.href = url;
      a.setAttribute('download', '');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    /* ============================================================
       CAPACITY
    ============================================================ */
    var _partyDates = []; /* [{date: "2026-03-14", label: "14일(토)", dayName: "토요일"}] */
    var _scarcityOverrides = {}; /* {"2026-03-14": "모집중"} */
    var _thresholdUrgent = 80;
    var _thresholdClosed = 100;
    var _defaultDays = ['금요일', '토요일', '일요일'];

    function _getDefaultPartyDates() {
      /* 다가오는 금/토/일 날짜를 자동 계산 */
      var now = new Date();
      var day = now.getDay();
      var daysUntilFri = (5 - day + 7) % 7;
      // 일요일 19시 이후 다음 주로 전환
      if (day === 6) daysUntilFri = -1;
      if (day === 0 && now.getHours() < 19) daysUntilFri = -2;
      var fri = new Date(now); fri.setDate(now.getDate() + daysUntilFri);
      var sat = new Date(fri); sat.setDate(fri.getDate() + 1);
      var sun = new Date(fri); sun.setDate(fri.getDate() + 2);
      var shortDay = { '금요일': '금', '토요일': '토', '일요일': '일' };
      var map = { '금요일': fri, '토요일': sat, '일요일': sun };
      return _defaultDays.map(function(dayName) {
        var d = map[dayName];
        var fmt = function(dt) { return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0'); };
        return {
          date: fmt(d),
          label: d.getDate() + '일(' + shortDay[dayName] + ')',
          dayName: dayName
        };
      });
    }

    function loadCapacity() {
      Promise.all([
        fetch(API_BASE + '/api/scarcity').then(function(r) { return r.ok ? r.json() : {}; }),
        fetch(API_BASE + '/api/party-dates', { headers: { 'Authorization': 'Bearer ' + state.token } }).then(function(r) { return r.ok ? r.json() : { dates: [] }; }),
        fetch(API_BASE + '/api/site-content').then(function(r) { return r.ok ? r.json() : {}; })
      ]).then(function(results) {
        var scarcityData = results[0];
        _partyDates = (results[1].dates || []);
        var siteContent = (results[2].content || {});
        try { _scarcityOverrides = JSON.parse(siteContent.scarcity_override || '{}'); } catch(e) { _scarcityOverrides = {}; }
        if (siteContent.scarcity_threshold_urgent) _thresholdUrgent = parseInt(siteContent.scarcity_threshold_urgent, 10) || 80;
        if (siteContent.scarcity_threshold_closed) _thresholdClosed = parseInt(siteContent.scarcity_threshold_closed, 10) || 100;
        var urgentEl = document.getElementById('threshold-urgent');
        var closedEl = document.getElementById('threshold-closed');
        if (urgentEl) urgentEl.value = _thresholdUrgent;
        if (closedEl) closedEl.value = _thresholdClosed;
        /* Populate scarcity badge text */
        var badgeTextEl = document.getElementById('scarcity-badge-text');
        if (badgeTextEl && siteContent['scarcity-badge-text']) badgeTextEl.value = siteContent['scarcity-badge-text'];
        renderCapacity(scarcityData);
        renderPartyDatesList();
      }).catch(function() {
        document.getElementById('capacity-grid').innerHTML =
          '<div class="content-group" style="text-align:center;color:var(--muted);">데이터를 불러오지 못했습니다.</div>';
      });
    }

    function getPartyDateKey(partyDate) {
      if (!partyDate) return '';
      return partyDate.date || partyDate.dayName || partyDate.label || '';
    }

    function getCapacityItems() {
      return (_partyDates.length > 0 ? _partyDates : _getDefaultPartyDates()).map(function(pd) {
        return {
          key: getPartyDateKey(pd),
          label: pd.label || pd.date || pd.dayName || '',
          dayName: pd.dayName || '',
          date: pd.date || ''
        };
      }).filter(function(item) { return !!item.key; });
    }

    function getScarcityInfoByKey(dates, key, dayName) {
      return dates[key] || (dayName ? dates[dayName] : null) || {};
    }



    function renderPartyDatesList() {
      var el = document.getElementById('party-dates-list');
      if (!el) return;
      if (_partyDates.length === 0) {
        el.innerHTML = '<p style="color:var(--muted);margin-bottom:8px;">설정된 날짜가 없습니다. 위에서 날짜를 추가해 주세요.</p>';
        return;
      }
      var scarcityColors = { '모집중': '#22c55e', '마감임박': '#f59e0b', '마감': '#ef4444' };
      var html = '<table style="width:100%;font-size:var(--fs-sm);border-collapse:collapse;">';
      html += '<thead><tr style="text-align:left;color:var(--muted);border-bottom:1px solid var(--border);">';
      html += '<th style="padding:6px;">표시명</th><th style="padding:6px;">날짜</th><th style="padding:6px;">요일</th><th style="padding:6px;">상태</th><th style="padding:6px;text-align:right;">관리</th></tr></thead><tbody>';
      _partyDates.forEach(function(d, i) {
        var overrideKey = getPartyDateKey(d);
        var legacyKey = d.dayName || '';
        var isManual = _scarcityOverrides.hasOwnProperty(overrideKey) || (legacyKey && _scarcityOverrides.hasOwnProperty(legacyKey));
        var currentStatus = _scarcityOverrides[overrideKey] || (legacyKey ? _scarcityOverrides[legacyKey] : '') || '';
        var statusColor = isManual ? (scarcityColors[currentStatus] || '#22c55e') : 'var(--muted)';
        html += '<tr style="border-bottom:1px solid var(--border);">';
        html += '<td style="padding:6px;font-weight:600;">' + esc(d.label || d.date) + '</td>';
        html += '<td style="padding:6px;">' + esc(d.date || '') + '</td>';
        html += '<td style="padding:6px;">' + esc(d.dayName || '') + '</td>';
        html += '<td style="padding:6px;">';
        html += '<select onchange="changePartyDateStatus(' + i + ', this.value)" style="padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:' + statusColor + ';font-weight:600;font-size:var(--fs-xs);cursor:pointer;">';
        html += '<option value=""' + (!isManual ? ' selected' : '') + '>자동</option>';
        ['모집중', '마감임박', '마감'].forEach(function(s) {
          html += '<option value="' + s + '"' + (s === currentStatus ? ' selected' : '') + '>' + s + '</option>';
        });
        html += '</select>';
        html += '</td>';
        html += '<td style="padding:6px;text-align:right;white-space:nowrap;">';
        html += '<button class="save-btn" style="padding:4px 10px;font-size:var(--fs-xs);margin-right:4px;" onclick="editPartyDate(' + i + ')">수정</button>';
        html += '<button class="save-btn" style="padding:4px 10px;font-size:var(--fs-xs);background:#ef4444;" onclick="removePartyDate(' + i + ')">삭제</button>';
        html += '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    function removePartyDate(idx) {
      var removed = _partyDates[idx];
      if (!confirm((removed.label || removed.date) + ' 날짜를 삭제하시겠습니까?')) return;
      delete _scarcityOverrides[getPartyDateKey(removed)];
      _partyDates.splice(idx, 1);
      savePartyDates();
    }

    function editPartyDate(idx) {
      var d = _partyDates[idx];
      var newLabel = prompt('표시명:', d.label || d.date);
      if (newLabel === null) return;
      var newDate = prompt('날짜 (YYYY-MM-DD):', d.date || '');
      if (newDate === null) return;
      var newDayName = prompt('요일명 (예: 토요일):', d.dayName || '');
      if (newDayName === null) return;
      var prevKey = getPartyDateKey(d);
      _partyDates[idx] = { date: newDate.trim(), label: newLabel.trim(), dayName: newDayName.trim() };
      var nextKey = getPartyDateKey(_partyDates[idx]);
      if (prevKey !== nextKey && _scarcityOverrides.hasOwnProperty(prevKey)) {
        _scarcityOverrides[nextKey] = _scarcityOverrides[prevKey];
        delete _scarcityOverrides[prevKey];
      }
      savePartyDates();
    }

    function changeCapacityStatus(dateKey, label, newStatus) {
      if (!dateKey) return;
      if (newStatus === '') {
        delete _scarcityOverrides[dateKey];
      } else {
        _scarcityOverrides[dateKey] = newStatus;
      }
      _saveScarcityOverrides(label || dateKey, newStatus === '' ? '자동' : newStatus);
    }

    function saveThresholds() {
      var urgent = parseInt(document.getElementById('threshold-urgent').value, 10);
      var closed = parseInt(document.getElementById('threshold-closed').value, 10);
      if (isNaN(urgent) || urgent < 1 || urgent > 99) { showToast('마감임박 기준은 1~99% 사이로 입력하세요.', true); return; }
      if (isNaN(closed) || closed < urgent) { showToast('마감 기준은 마감임박 기준 이상이어야 합니다.', true); return; }
      _thresholdUrgent = urgent;
      _thresholdClosed = closed;
      var badgeText = (document.getElementById('scarcity-badge-text').value || '').trim();
      var thresholdContent = { scarcity_threshold_urgent: String(urgent), scarcity_threshold_closed: String(closed) };
      if (badgeText) thresholdContent['scarcity-badge-text'] = badgeText;
      fetch(API_BASE + '/api/site-content', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: thresholdContent })
      })
      .then(function(r) {
        if (!r.ok) throw new Error();
        showToast('임계값이 저장되었습니다. (마감임박: ' + urgent + '%, 마감: ' + closed + '%)');
        loadCapacity();
      })
      .catch(function() { showToast('저장 실패', true); });
    }

    function _saveScarcityOverrides(dayName, displayStatus) {
      fetch(API_BASE + '/api/site-content', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: { scarcity_override: JSON.stringify(_scarcityOverrides) } })
      })
      .then(function(r) {
        if (!r.ok) throw new Error();
        showToast(dayName + ' 상태가 "' + displayStatus + '"(으)로 변경되었습니다.');
        loadCapacity();
      })
      .catch(function() { showToast('상태 변경 실패', true); });
    }

    function changePartyDateStatus(idx, newStatus) {
      var partyDate = _partyDates[idx];
      var dateKey = getPartyDateKey(partyDate);
      if (!dateKey) return;
      if (newStatus === '') {
        delete _scarcityOverrides[dateKey];
      } else {
        _scarcityOverrides[dateKey] = newStatus;
      }
      _saveScarcityOverrides(partyDate.label || dateKey, newStatus === '' ? '자동' : newStatus);
    }

    function savePartyDates() {
      fetch(API_BASE + '/api/admin/party-dates', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ dates: _partyDates })
      })
      .then(function(r) {
        if (!r.ok) throw new Error();
        showToast('파티 날짜가 저장되었습니다.');
        renderPartyDatesList();
        loadCapacity();
      })
      .catch(function() { showToast('저장 실패', true); });
    }

    document.addEventListener('DOMContentLoaded', function() {
      var addBtn = document.getElementById('add-party-date-btn');
      if (addBtn) {
        addBtn.addEventListener('click', function() {
          var dateInput = document.getElementById('new-party-date');
          var labelInput = document.getElementById('new-party-label');
          var dateVal = dateInput.value;
          if (!dateVal) { showToast('날짜를 선택해 주세요.', true); return; }

          var d = new Date(dateVal + 'T00:00:00');
          var dayNames = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
          var shortDays = ['일', '월', '화', '수', '목', '금', '토'];
          var dayName = dayNames[d.getDay()];
          var defaultLabel = (d.getMonth() + 1) + '/' + d.getDate() + '(' + shortDays[d.getDay()] + ')';
          var label = labelInput.value.trim() || defaultLabel;

          if (_partyDates.some(function(p) { return p.date === dateVal; })) {
            showToast('이미 추가된 날짜입니다.', true); return;
          }

          _partyDates.push({ date: dateVal, label: label, dayName: dayName });
          savePartyDates();
          dateInput.value = '';
          labelInput.value = '';
        });
      }
    });

    function renderCapacity(data) {
      var grid = document.getElementById('capacity-grid');
      var dates = data.dates || {};
      var items = getCapacityItems();
      var html = '';

      var scarcityColors = { '모집중': '#22c55e', '마감임박': '#f59e0b', '마감': '#ef4444' };
      items.forEach(function(item) {
        var info = getScarcityInfoByKey(dates, item.key, item.dayName);
        var capacity = info.capacity != null ? info.capacity : 30;
        var count = info.count != null ? info.count : 0;
        var pct = capacity > 0 ? Math.min(100, Math.round(count / capacity * 100)) : (capacity === 0 ? 100 : 0);
        var level = capacity === 0 ? 'high' : (pct < 50 ? 'low' : pct < 80 ? 'mid' : 'high');
        /* 수동 오버라이드 우선, 없으면 자동 계산된 level 사용 */
        var isManual = _scarcityOverrides.hasOwnProperty(item.key) || (item.dayName && _scarcityOverrides.hasOwnProperty(item.dayName));
        var currentStatus = _scarcityOverrides[item.key] || (item.dayName ? _scarcityOverrides[item.dayName] : '') || '';
        var displayLevel = isManual ? currentStatus : (info.level || '모집중');
        var statusColor = isManual ? (scarcityColors[currentStatus] || '#22c55e') : 'var(--muted)';
        var title = item.label || item.key;
        var meta = item.dayName && item.date ? item.dayName + ' · ' + item.date : (item.dayName || item.date || '');

        html += '<div class="capacity-card">' +
          '<div class="capacity-card-day">' + esc(title) + '</div>' +
          (meta ? '<div style="font-size:var(--fs-xs);color:var(--muted);margin-bottom:4px;">' + esc(meta) + '</div>' : '') +
          '<div class="capacity-stat">' + count + ' / ' + (capacity === 0 ? '마감' : capacity + '명') + ' (' + pct + '%)</div>' +
          '<div class="capacity-bar-wrap"><div class="capacity-bar level-' + level + '" style="width:' + pct + '%"></div></div>' +
          '<div class="capacity-input-row" style="margin-bottom:6px;">' +
            '<input class="capacity-input" type="number" min="0" value="' + esc(capacity) + '" data-day="' + esc(item.key) + '" placeholder="정원 (0=마감)" />' +
            '<button class="capacity-save-btn" data-day="' + esc(item.key) + '" data-label="' + esc(title) + '" type="button">저장</button>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);">' +
            '<span style="color:var(--muted);">상태:</span>' +
            '<select onchange="changeCapacityStatus(\'' + esc(item.key).replace(/'/g, "\\'") + '\', \'' + esc(title).replace(/'/g, "\\'") + '\', this.value)" ' +
              'style="padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:' + statusColor + ';font-weight:600;font-size:var(--fs-xs);cursor:pointer;">' +
              '<option value=""' + (!isManual ? ' selected' : '') + '>자동 (' + (info.level || '모집중') + ')</option>' +
              ['모집중', '마감임박', '마감'].map(function(s) { return '<option value="' + s + '"' + (s === currentStatus && isManual ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
            '</select>' +
          '</div>' +
        '</div>';
      });

      grid.innerHTML = html;

      grid.querySelectorAll('.capacity-save-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var day = this.getAttribute('data-day');
          var label = this.getAttribute('data-label') || day;
          var inp = grid.querySelector('.capacity-input[data-day="' + day + '"]');
          var cap = parseInt(inp.value, 10);
          if (isNaN(cap) || cap < 0) { showToast('올바른 숫자를 입력하세요.', true); return; }
          saveCapacity(day, label, cap);
        });
      });
    }

    function saveCapacity(day, label, capacity) {
      fetch(API_BASE + '/api/capacity', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ day: day, capacity: capacity })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('save_fail');
        showToast((label || day) + ' 정원이 ' + capacity + '명으로 저장되었습니다.');
        loadCapacity();
      })
      .catch(function() {
        showToast('저장 실패', true);
      });
    }

    /* ============================================================
       CONTENT MANAGEMENT
    ============================================================ */
    var CONTENT_FIELD_IDS = [
      'hero-title', 'main-hero-sub', 'sticky-cta-text',
      'intro-title', 'main-about-p1', 'main-about-p2',
      'faq-title', 'price-title',
      'main-price-info', 'main-price-note-건대', 'main-price-note-영등포',
      'gallery-title',
      'main-cta-title', 'main-cta-sub',
      'form-title', 'form-subtitle', 'form-submit-note',
      'form-rules-title', 'form-rules-list',
      'form-refund-title', 'form-refund-list', 'form-refund-notice',
      'complete-title', 'complete-sub',
      'complete-notice-title', 'complete-notice-body'
    ];

    /* ── FAQ ── */
    function loadFaqList() {
      fetch(API_BASE + '/api/admin/faq', { headers: authHeaders() })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) {
          var el = document.getElementById('faq-list');
          if (!d || !d.faq || d.faq.length === 0) {
            el.innerHTML = '<p style="color:var(--muted);font-size:var(--fs-sm);">등록된 질문이 없습니다.</p>';
            return;
          }
          el.innerHTML = d.faq.map(function(f) {
            return '<div class="content-group" style="border:1px solid var(--border);padding:12px;border-radius:8px;margin-bottom:12px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
              '<strong style="font-size:var(--fs-sm);">Q. ' + f.question.substring(0, 40) + '</strong>' +
              '<span style="font-size:var(--fs-xs);color:var(--muted);">순서: ' + f.sort_order + '</span></div>' +
              '<input class="settings-input" type="text" id="faq-q-' + f.id + '" value="' + f.question.replace(/"/g, '&quot;') + '" style="width:100%;margin-bottom:8px;" />' +
              '<textarea class="content-textarea" id="faq-a-' + f.id + '" rows="2" style="width:100%;margin-bottom:8px;">' + f.answer + '</textarea>' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
              '<input class="settings-input" type="number" id="faq-o-' + f.id + '" value="' + f.sort_order + '" style="width:80px;" />' +
              '<label style="font-size:var(--fs-xs);display:flex;align-items:center;gap:4px;">' +
              '<input type="checkbox" id="faq-active-' + f.id + '"' + (f.is_active ? ' checked' : '') + '> 표시</label>' +
              '<button type="button" onclick="updateFaq(' + f.id + ')" style="font-size:var(--fs-xs);padding:4px 12px;background:#3498db;color:#fff;border:none;border-radius:6px;cursor:pointer;">저장</button>' +
              '<button type="button" onclick="deleteFaq(' + f.id + ')" style="font-size:var(--fs-xs);padding:4px 12px;background:#e74c3c;color:#fff;border:none;border-radius:6px;cursor:pointer;">삭제</button>' +
              '</div></div>';
          }).join('');
        })
        .catch(function() {
          document.getElementById('faq-list').innerHTML = '<p style="color:var(--muted);font-size:var(--fs-sm);">FAQ를 불러오지 못했습니다.</p>';
        });
    }

    function createFaq() {
      var question = document.getElementById('faq-new-question').value.trim();
      var answer = document.getElementById('faq-new-answer').value.trim();
      var sort_order = parseInt(document.getElementById('faq-new-order').value) || 0;
      if (!question || !answer) { showToast('질문과 답변을 모두 입력해 주세요.', true); return; }
      fetch(API_BASE + '/api/admin/faq', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ question: question, answer: answer, sort_order: sort_order })
      })
      .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function() {
        showToast('질문이 추가되었습니다.');
        document.getElementById('faq-new-question').value = '';
        document.getElementById('faq-new-answer').value = '';
        document.getElementById('faq-new-order').value = '0';
        loadFaqList();
      })
      .catch(function() { showToast('질문 추가에 실패했습니다.', true); });
    }

    function updateFaq(id) {
      var question = document.getElementById('faq-q-' + id).value.trim();
      var answer = document.getElementById('faq-a-' + id).value.trim();
      var sort_order = parseInt(document.getElementById('faq-o-' + id).value) || 0;
      var is_active = document.getElementById('faq-active-' + id).checked ? 1 : 0;
      fetch(API_BASE + '/api/admin/faq/update', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ id: id, question: question, answer: answer, sort_order: sort_order, is_active: is_active })
      })
      .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function() { showToast('질문이 수정되었습니다.'); loadFaqList(); })
      .catch(function() { showToast('수정에 실패했습니다.', true); });
    }

    function deleteFaq(id) {
      if (!confirm('이 질문을 삭제하시겠습니까?')) return;
      fetch(API_BASE + '/api/admin/faq/delete', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ id: id })
      })
      .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function() { showToast('질문이 삭제되었습니다.'); loadFaqList(); })
      .catch(function() { showToast('삭제에 실패했습니다.', true); });
    }

    /* ── Pricing (dynamic branches) ── */
    var _branches = []; /* [{name, male, female, note}] */

    function renderBranchList() {
      var container = document.getElementById('branch-list-container');
      container.innerHTML = _branches.map(function(b, i) {
        return '<div class="content-group" data-branch-idx="' + i + '">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<p class="content-group-title" style="margin:0;">' + b.name + '점</p>' +
            '<button type="button" onclick="removeBranch(' + i + ')" style="font-size:11px;padding:2px 8px;background:transparent;color:#e74c3c;border:1px solid #e74c3c;border-radius:4px;cursor:pointer;">삭제</button>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:8px;">' +
            '<div><label class="content-label">남성 참가비 (원)</label>' +
              '<input class="settings-input branch-price-input" type="number" data-branch="' + i + '" data-field="male" value="' + (b.male || 0) + '" style="width:100%;" /></div>' +
            '<div><label class="content-label">여성 참가비 (원)</label>' +
              '<input class="settings-input branch-price-input" type="number" data-branch="' + i + '" data-field="female" value="' + (b.female || 0) + '" style="width:100%;" /></div>' +
            '<div><label class="content-label">비고</label>' +
              '<input class="settings-input branch-price-input" type="text" data-branch="' + i + '" data-field="note" value="' + (b.note || '') + '" style="width:100%;" placeholder="예: 포틀럭 포함" /></div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:4px;">' +
            '<div><label class="content-label">2부 기본가 (원)</label>' +
              '<input class="settings-input branch-price-input" type="number" data-branch="' + i + '" data-field="part2_base" value="' + (b.part2_base != null ? b.part2_base : 18000) + '" style="width:100%;" /></div>' +
            '<div><label class="content-label">2부 선결제 할인율 (%)</label>' +
              '<input class="settings-input branch-price-input" type="number" data-branch="' + i + '" data-field="part2_discount" value="' + (b.part2_discount != null ? b.part2_discount : 10) + '" min="0" max="50" style="width:100%;" /></div>' +
          '</div>' +
        '</div>';
      }).join('');
      /* Bind input events for live preview */
      container.querySelectorAll('.branch-price-input').forEach(function(inp) {
        inp.addEventListener('input', function() {
          var idx = parseInt(inp.getAttribute('data-branch'));
          var field = inp.getAttribute('data-field');
          if (field === 'note') _branches[idx].note = inp.value;
          else _branches[idx][field] = parseInt(inp.value) || 0;
          updatePricePreview();
        });
      });
      updatePricePreview();
    }

    function addBranch(name, male, female, note) {
      _branches.push({ name: name || '', male: male || 0, female: female || 0, note: note || '', part2_base: 18000, part2_discount: 10 });
      renderBranchList();
    }

    function removeBranch(idx) {
      if (!confirm(_branches[idx].name + '점을 삭제하시겠습니까?')) return;
      _branches.splice(idx, 1);
      renderBranchList();
    }

    document.getElementById('add-branch-btn').addEventListener('click', function() {
      var name = prompt('새 지점 이름을 입력하세요 (예: 홍대)');
      if (!name || !name.trim()) return;
      name = name.trim();
      if (_branches.some(function(b) { return b.name === name; })) {
        showToast('이미 존재하는 지점입니다.', true);
        return;
      }
      addBranch(name, 30000, 20000, '');
    });

    function loadPricing() {
      fetch(API_BASE + '/api/pricing', { headers: authHeaders() })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) {
          if (!d || !d.pricing) return;
          var p = d.pricing;
          _branches = [];
          Object.keys(p).forEach(function(key) {
            if (key === 'part2_base' || key === 'part2_discount') return;
            var b = p[key];
            var globalP2Base = p.part2_base != null ? p.part2_base : 18000;
            var globalP2Disc = p.part2_discount != null ? p.part2_discount : 10;
            _branches.push({
              name: key, male: b.male || 0, female: b.female || 0, note: b.note || '',
              part2_base: b.part2_base != null ? b.part2_base : globalP2Base,
              part2_discount: b.part2_discount != null ? b.part2_discount : globalP2Disc
            });
          });
          if (_branches.length === 0) {
            _branches = [
              { name: '건대', male: 33000, female: 23000, note: '포틀럭 포함', part2_base: 18000, part2_discount: 10 },
              { name: '영등포', male: 39500, female: 29500, note: '안주 포함', part2_base: 18000, part2_discount: 10 }
            ];
          }
          renderBranchList();
          updatePricePreview();
        })
        .catch(function() {});
    }

    function savePricing() {
      var pricing = {};
      _branches.forEach(function(b) {
        pricing[b.name] = {
          male: b.male, female: b.female, note: b.note || '',
          part2_base: b.part2_base != null ? b.part2_base : 18000,
          part2_discount: b.part2_discount != null ? b.part2_discount : 10
        };
      });
      fetch(API_BASE + '/api/pricing', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ pricing: pricing })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('save_fail');
        showToast('가격이 저장되었습니다.');
      })
      .catch(function() { showToast('가격 저장에 실패했습니다.', true); });
    }

    function bindContent() {
      document.getElementById('save-content-btn').addEventListener('click', saveContent);
    }

    function loadSiteContent() {
      fetch(API_BASE + '/api/site-content', { headers: { 'Authorization': 'Bearer ' + state.token } })
      .then(function(r) {
        if (!r.ok) throw new Error('content_fail');
        return r.json();
      })
      .then(function(data) {
        var content = data.content || data;
        /* Populate hidden fields */
        CONTENT_FIELD_IDS.forEach(function(id) {
          var el = document.getElementById(id);
          if (el && content[id] !== undefined) el.value = content[id];
        });
        /* Inject into already-loaded iframes */
        ['preview-main', 'preview-form', 'preview-complete'].forEach(function(iframeId) {
          var iframe = document.getElementById(iframeId);
          if (iframe) injectSavedContentIntoIframe(iframe, iframeId);
        });
        /* Clear pending state on fresh load */
        pendingChanges = {};
        pendingAccountChanges = {};
        updatePendingBadge();
      })
      .catch(function() {
        showToast('콘텐츠를 불러오지 못했습니다.', true);
      });
    }

    function saveContent() {
      var content = {};
      /* Only save fields that have actual content (skip empty to preserve HTML defaults) */
      CONTENT_FIELD_IDS.forEach(function(id) {
        var el = document.getElementById(id);
        if (el && el.value && el.value.trim()) content[id] = el.value;
      });

      /* Also collect from pending iframe edits (these are intentional changes) */
      Object.keys(pendingChanges).forEach(function(id) {
        if (pendingChanges[id] && pendingChanges[id].trim()) {
          content[id] = pendingChanges[id];
        }
      });

      /* Include scarcity overrides in content */
      if (Object.keys(pendingScarcityOverrides).length > 0) {
        content['scarcity_override'] = JSON.stringify(pendingScarcityOverrides);
      }

      var savePromises = [];

      /* Save site content */
      savePromises.push(
        fetch(API_BASE + '/api/site-content', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ content: content })
        }).then(function(r) { if (!r.ok) throw new Error('save_fail'); })
      );

      /* Save account info if changed */
      if (Object.keys(pendingAccountChanges).length > 0) {
        /* Fetch current account info first, then merge */
        savePromises.push(
          fetch(API_BASE + '/api/admin/account', { headers: authHeaders() })
          .then(function(r) { return r.ok ? r.json() : { account: { bank: '농협은행', account_number: '351-0948-4473-43', holder: '이@봄' } }; })
          .then(function(data) {
            var current = data.account || { bank: '농협은행', account_number: '351-0948-4473-43', holder: '이@봄' };
            var merged = Object.assign({}, current, pendingAccountChanges);
            return fetch(API_BASE + '/api/admin/account', {
              method: 'POST',
              headers: authHeaders(),
              body: JSON.stringify(merged)
            });
          })
          .then(function(r) { if (!r.ok) throw new Error('account_save_fail'); })
        );
      }

      Promise.all(savePromises)
      .then(function() {
        var msg = document.getElementById('save-success-msg');
        msg.classList.add('visible');
        setTimeout(function() { msg.classList.remove('visible'); }, 2500);
        showToast('콘텐츠가 저장되었습니다.');

        /* Mark all edited elements as saved (green → remove after delay) */
        ['preview-main', 'preview-form', 'preview-complete'].forEach(function(iframeId) {
          try {
            var iframe = document.getElementById(iframeId);
            var iDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (!iDoc) return;
            iDoc.querySelectorAll('.admin-edited').forEach(function(el) {
              el.style.outline = '2px solid rgba(46,204,113,0.8)';
              el.style.outlineOffset = '2px';
              setTimeout(function() {
                el.style.outline = '';
                el.style.outlineOffset = '';
                el.classList.remove('admin-edited');
              }, 2000);
            });
          } catch(e) {}
        });

        /* Clear pending state (don't reload iframes - values are already in the DOM) */
        pendingChanges = {};
        pendingAccountChanges = {};
        pendingScarcityOverrides = {};
        updatePendingBadge();
      })
      .catch(function() {
        showToast('저장 실패', true);
      });
    }

    /* ============================================================
       DISCOUNT CODES
    ============================================================ */
    function bindDiscount() {
      document.getElementById('dc-generate').addEventListener('click', function() {
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        var code = 'ODD-';
        for (var i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        document.getElementById('dc-code').value = code;
      });

      document.getElementById('dc-create').addEventListener('click', function() {
        var code = document.getElementById('dc-code').value.trim();
        var dtype = document.getElementById('dc-type').value;
        var dval = parseInt(document.getElementById('dc-value').value) || 0;
        var dmax = parseInt(document.getElementById('dc-max').value) || 0;

        if (!code) { showToast('할인코드를 입력해 주세요.', true); return; }
        if (dval <= 0) { showToast('할인값을 입력해 주세요.', true); return; }

        fetch(API_BASE + '/api/discount-codes', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ code: code, discount_type: dtype, discount_value: dval, max_uses: dmax })
        })
        .then(function(r) {
          if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || '생성 실패'); });
          return r.json();
        })
        .then(function() {
          showToast('할인코드가 생성되었습니다.');
          document.getElementById('dc-code').value = '';
          document.getElementById('dc-value').value = '';
          document.getElementById('dc-max').value = '0';
          loadDiscountCodes();
        })
        .catch(function(e) { showToast(e.message, true); });
      });

      loadDiscountCodes();
    }

    function loadDiscountCodes() {
      fetch(API_BASE + '/api/discount-codes', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var codes = data.discount_codes || data.codes || [];
        var el = document.getElementById('dc-list');
        if (!codes.length) {
          el.innerHTML = '<p style="color:var(--muted);font-size:var(--fs-sm);">발급된 할인코드가 없습니다.</p>';
          return;
        }
        var html = '<table style="width:100%;font-size:var(--fs-sm);border-collapse:collapse;">';
        html += '<thead><tr style="text-align:left;color:var(--muted);border-bottom:1px solid var(--border);">';
        html += '<th style="padding:8px 6px;">코드</th><th style="padding:8px 6px;">할인</th><th style="padding:8px 6px;">사용</th><th style="padding:8px 6px;">상태</th><th style="padding:8px 6px;text-align:right;">관리</th></tr></thead><tbody>';
        codes.forEach(function(c) {
          var discountText = c.discount_type === 'percent' ? c.discount_value + '%' : c.discount_value.toLocaleString() + '원';
          var usageText = c.used_count + (c.max_uses > 0 ? '/' + c.max_uses : '/∞');
          var statusText = c.is_active ? '<span style="color:#22c55e;">활성</span>' : '<span style="color:var(--muted);">비활성</span>';
          var toggleLabel = c.is_active ? '비활성화' : '활성화';
          html += '<tr style="border-bottom:1px solid var(--border);" data-dc-id="' + c.id + '">';
          html += '<td style="padding:8px 6px;font-weight:600;font-family:monospace;">' + esc(c.code) + '</td>';
          html += '<td style="padding:8px 6px;">' + discountText + '</td>';
          html += '<td style="padding:8px 6px;">' + usageText + '</td>';
          html += '<td style="padding:8px 6px;">' + statusText + '</td>';
          html += '<td style="padding:8px 6px;text-align:right;white-space:nowrap;">';
          html += '<button class="save-btn" style="padding:4px 10px;font-size:var(--fs-xs);margin-right:4px;" onclick="editDiscountCode(' + c.id + ')">수정</button>';
          html += '<button class="save-btn" style="padding:4px 10px;font-size:var(--fs-xs);margin-right:4px;background:var(--muted);" onclick="toggleDiscountCode(' + c.id + ',' + (c.is_active ? 0 : 1) + ')">' + toggleLabel + '</button>';
          html += '<button class="save-btn" style="padding:4px 10px;font-size:var(--fs-xs);background:#ef4444;" onclick="deleteDiscountCode(' + c.id + ',\'' + esc(c.code) + '\')">삭제</button>';
          html += '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;
      })
      .catch(function() {
        document.getElementById('dc-list').innerHTML = '<p style="color:var(--muted);font-size:var(--fs-sm);">할인코드를 불러오지 못했습니다.</p>';
      });
    }

    function toggleDiscountCode(id, newState) {
      fetch(API_BASE + '/api/admin/discount-codes/update', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: id, is_active: newState })
      })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || '변경 실패'); });
        return r.json();
      })
      .then(function() {
        showToast(newState ? '할인코드가 활성화되었습니다.' : '할인코드가 비활성화되었습니다.');
        loadDiscountCodes();
      })
      .catch(function(e) { showToast(e.message, true); });
    }

    function deleteDiscountCode(id, code) {
      if (!confirm('할인코드 "' + code + '"을(를) 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return;
      fetch(API_BASE + '/api/admin/discount-codes/delete', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: id })
      })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || '삭제 실패'); });
        return r.json();
      })
      .then(function() {
        showToast('할인코드가 삭제되었습니다.');
        loadDiscountCodes();
      })
      .catch(function(e) { showToast(e.message, true); });
    }

    function editDiscountCode(id) {
      var row = document.querySelector('tr[data-dc-id="' + id + '"]');
      if (!row) return;
      var cells = row.querySelectorAll('td');
      var code = cells[0].textContent;
      var currentDiscount = cells[1].textContent;
      var currentUsage = cells[2].textContent;

      var newType = prompt('할인 종류 (fixed 또는 percent):', currentDiscount.includes('%') ? 'percent' : 'fixed');
      if (newType === null) return;
      if (newType !== 'fixed' && newType !== 'percent') {
        showToast('할인 종류는 fixed 또는 percent만 가능합니다.', true);
        return;
      }

      var newValue = prompt('할인값' + (newType === 'percent' ? ' (%)' : ' (원)') + ':', parseInt(currentDiscount));
      if (newValue === null) return;
      newValue = parseInt(newValue);
      if (isNaN(newValue) || newValue <= 0) {
        showToast('유효한 할인값을 입력해 주세요.', true);
        return;
      }

      var currentMax = currentUsage.split('/')[1];
      var newMax = prompt('최대 사용 횟수 (0=무제한):', currentMax === '∞' ? '0' : currentMax);
      if (newMax === null) return;
      newMax = parseInt(newMax) || 0;

      fetch(API_BASE + '/api/admin/discount-codes/update', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: id, discount_type: newType, discount_value: newValue, max_uses: newMax })
      })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || '수정 실패'); });
        return r.json();
      })
      .then(function() {
        showToast('할인코드 "' + code + '"이(가) 수정되었습니다.');
        loadDiscountCodes();
      })
      .catch(function(e) { showToast(e.message, true); });
    }

    /* ============================================================
       SETTINGS
    ============================================================ */
    /* ============================================================
       ACCOUNT INFO
    ============================================================ */
    function loadAccountInfo() {
      fetch(API_BASE + '/api/admin/account', { headers: authHeaders() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d) return;
        if (d.bank) document.getElementById('account-bank').value = d.bank;
        if (d.account_number) document.getElementById('account-number-input').value = d.account_number;
        if (d.holder) document.getElementById('account-holder').value = d.holder;
      })
      .catch(function() {});
    }

    function saveAccountInfo() {
      var data = {
        bank: document.getElementById('account-bank').value.trim(),
        account_number: document.getElementById('account-number-input').value.trim(),
        holder: document.getElementById('account-holder').value.trim()
      };
      if (!data.bank || !data.account_number || !data.holder) {
        showToast('모든 항목을 입력해 주세요.', true); return;
      }
      fetch(API_BASE + '/api/admin/account', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify(data)
      })
      .then(function(r) {
        if (!r.ok) throw new Error();
        showToast('계좌 정보가 저장되었습니다.');
      })
      .catch(function() { showToast('계좌 정보 저장 실패', true); });
    }

    /* Load instagram-id when settings section opens */
    function loadSettingsContent() {
      fetch(API_BASE + '/api/site-content')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d) return;
        var content = d.content || {};
        var igEl = document.getElementById('instagram-id');
        if (igEl && content['instagram-id']) igEl.value = content['instagram-id'];
      })
      .catch(function() {});
    }

    function saveInstagramId() {
      var igId = (document.getElementById('instagram-id').value || '').trim();
      if (!igId) { showToast('인스타그램 아이디를 입력해주세요.', true); return; }
      fetch(API_BASE + '/api/site-content', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: { 'instagram-id': igId } })
      })
      .then(function(r) {
        if (!r.ok) throw new Error();
        showToast('인스타그램 아이디가 저장되었습니다.');
      })
      .catch(function() { showToast('저장 실패', true); });
    }

    /* ============================================================
       DETAIL MODAL
    ============================================================ */
    var modalAppId = null;

    function openDetailModal(app) {
      modalAppId = app.id;
      var fields = [
        { k: '신청일시', v: formatDate(app.createdAt) },
        { k: '이름', v: app.name },
        { k: '나이', v: app.age ? app.age + '세' : '—' },
        { k: '전화번호', v: app.phone },
        { k: '성별', v: app.gender === 'male' ? '남성' : app.gender === 'female' ? '여성' : (app.priceText && app.priceText.charAt(0) === '남' ? '남성' : app.priceText && app.priceText.charAt(0) === '여' ? '여성' : '—') },
        { k: '지점', v: app.branch || '—' },
        { k: '파티날짜', v: app.partyDate || '—' },
        { k: '금액', v: app.priceText || (app.totalPrice ? app.totalPrice.toLocaleString() + '원' : '—') },
        { k: '2부 참여', v: app.part2pay === 'prepay' ? '사전결제' : app.part2pay === 'onsite' ? '현장결제' : '미참여' },
        { k: '인스타그램', v: app.instagram ? '@' + app.instagram : '—' },
        { k: '쿠폰', v: app.coupon || '—' },
        { k: '상태', v: app.status || '입금대기' },
        { k: '관리자 메모', v: app.adminNote || '—' },
        { k: 'ID', v: app.id },
      ];
      var html = fields.map(function(f) {
        if (f.k === '파티날짜') {
          return '<div class="modal-detail-row"><span class="modal-detail-key">' + esc(f.k) + '</span>' +
            '<span class="modal-detail-val" style="display:flex;align-items:center;gap:8px;">' +
            '<input type="text" id="modal-edit-date" value="' + esc(f.v) + '" class="note-input" style="width:140px;" />' +
            '<button type="button" id="modal-save-date" style="font-size:11px;padding:3px 10px;background:var(--gradient-btn);color:#fff;border:none;border-radius:4px;cursor:pointer;">저장</button>' +
            '</span></div>';
        }
        return '<div class="modal-detail-row"><span class="modal-detail-key">' + esc(f.k) + '</span><span class="modal-detail-val">' + esc(f.v) + '</span></div>';
      }).join('');
      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('detail-modal').style.display = 'flex';

      var saveDateBtn = document.getElementById('modal-save-date');
      if (saveDateBtn) {
        saveDateBtn.addEventListener('click', function() {
          var newDate = document.getElementById('modal-edit-date').value.trim();
          if (!newDate) return;
          patchApplication(modalAppId, { party_date: newDate });
          state.apps.forEach(function(a) {
            if (a.id == modalAppId) a.partyDate = newDate;
          });
          showToast('파티 날짜가 수정되었습니다.');
          applyFilters();
        });
      }
    }

    function closeDetailModal() {
      document.getElementById('detail-modal').style.display = 'none';
      modalAppId = null;
    }

    function deleteApplication() {
      if (!modalAppId) return;
      if (!confirm('이 신청자를 정말 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
      fetch(API_BASE + '/api/admin/applications/delete', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ id: modalAppId })
      })
      .then(function(r) {
        if (!r.ok) throw new Error();
        showToast('신청이 삭제되었습니다.');
        closeDetailModal();
        loadDashboard();
      })
      .catch(function() { showToast('삭제에 실패했습니다.', true); });
    }

    document.getElementById('modal-close-btn').addEventListener('click', closeDetailModal);
    document.getElementById('modal-close-btn2').addEventListener('click', closeDetailModal);
    document.getElementById('modal-delete-btn').addEventListener('click', deleteApplication);
    document.getElementById('detail-modal').addEventListener('click', function(e) {
      if (e.target === this) closeDetailModal();
    });

    /* ============================================================
       REVENUE STATS
    ============================================================ */
    function updateRevenueStats() {
      var paid = state.apps.filter(function(a) { return a.status === '입금완료'; });
      var grid = document.getElementById('revenue-grid');
      if (paid.length === 0) {
        grid.style.display = 'none';
        return;
      }
      grid.style.display = 'grid';

      var total = 0, branchData = {};
      paid.forEach(function(a) {
        var price = a.totalPrice || a.priceAmount || a.price || 0;
        total += price;
        var b = a.branch || '기타';
        if (!branchData[b]) branchData[b] = { sum: 0, count: 0 };
        branchData[b].sum += price;
        branchData[b].count++;
      });

      var html = '<div class="revenue-card"><div class="revenue-card-label">총 매출 (입금완료)</div>' +
        '<div class="revenue-card-value">' + total.toLocaleString() + '원</div>' +
        '<div class="revenue-card-sub">' + paid.length + '건</div></div>';
      Object.keys(branchData).sort().forEach(function(b) {
        var d = branchData[b];
        html += '<div class="revenue-card"><div class="revenue-card-label">' + esc(b) + '점 매출</div>' +
          '<div class="revenue-card-value">' + d.sum.toLocaleString() + '원</div>' +
          '<div class="revenue-card-sub">' + d.count + '건</div></div>';
      });
      grid.innerHTML = html;
      grid.style.gridTemplateColumns = 'repeat(' + Math.min(Object.keys(branchData).length + 1, 4) + ', 1fr)';
    }

    /* ============================================================
       3-PHONE VISUAL EDITOR (inline iframe editing)
    ============================================================ */

    /* Editable element IDs per iframe */
    var IFRAME_EDITABLE_MAP = {
      'preview-main': [
        'hero-title', 'main-hero-sub',
        'intro-title', 'main-about-p1', 'main-about-p2',
        'faq-title', 'price-title',
        'main-price-info', 'main-price-note-건대', 'main-price-note-영등포',
        'gallery-title',
        'main-cta-title', 'main-cta-sub'
      ],
      'preview-form': [
        'form-title', 'form-subtitle',
        'form-submit-note',
        'form-rules-title', 'form-rules-list',
        'form-refund-title', 'form-refund-list', 'form-refund-notice'
      ],
      'preview-complete': [
        'complete-title', 'complete-sub',
        'complete-notice-title', 'complete-notice-body'
      ]
    };

    /* Account info fields (special handling - saved via /api/admin/account) */
    var ACCOUNT_EDITABLE_MAP = {
      'preview-form': {
        'form-bank-name': 'bank',
        'account-number': 'account_number',
        'form-account-holder': 'holder'
      },
      'preview-complete': {
        'complete-bank-name': 'bank',
        'account-number': 'account_number',
        'complete-account-holder': 'holder'
      }
    };

    var pendingChanges = {};
    var pendingAccountChanges = {};

    function refreshPreview(iframeId) {
      var iframe = document.getElementById(iframeId);
      if (iframe) {
        iframe.classList.remove('ready');
        iframe.src = iframe.src;
        /* load handler in setup block handles re-injection and reveal */
      }
    }

    /* Scarcity override state */
    var pendingScarcityOverrides = {};

    function injectEditableOverlay(iframe, iframeId) {
      try {
        var iDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (!iDoc || !iDoc.body) return;

        /* ── Disable all functional elements ── */
        var disableStyle = iDoc.createElement('style');
        disableStyle.textContent =
          'a,button,.btn,.submit-btn,.copy-btn,.share-btn,.sticky-cta{pointer-events:none !important;}' +
          'input,textarea,select{pointer-events:none !important;}' +
          'form{pointer-events:none !important;}' +
          '.sticky-cta{display:none !important;}' +
          '[data-admin-editable],[data-admin-account-editable],[data-admin-scarcity]{pointer-events:auto !important;cursor:pointer !important;}';
        iDoc.head.appendChild(disableStyle);

        /* Prevent all navigation */
        iDoc.addEventListener('click', function(e) {
          var target = e.target;
          if (target.hasAttribute('data-admin-editable') || target.hasAttribute('data-admin-account-editable') || target.hasAttribute('data-admin-scarcity')) return;
          if (target.closest('[data-admin-editable]') || target.closest('[data-admin-account-editable]') || target.closest('[data-admin-scarcity]')) return;
          e.preventDefault();
          e.stopPropagation();
        }, true);

        /* Prevent form submissions */
        iDoc.querySelectorAll('form').forEach(function(f) {
          f.addEventListener('submit', function(e) { e.preventDefault(); e.stopPropagation(); }, true);
        });

        /* Disable JS-loaded scripts from running further interactions */
        iDoc.querySelectorAll('input,textarea,select,button').forEach(function(el) {
          if (!el.closest('[data-admin-editable]') && !el.closest('[data-admin-account-editable]')) {
            el.setAttribute('tabindex', '-1');
            el.disabled = true;
          }
        });

        /* Hide scrollbar inside iframe */
        var scrollStyle = iDoc.createElement('style');
        scrollStyle.textContent =
          'html,body{scrollbar-width:none;-ms-overflow-style:none;}' +
          'html::-webkit-scrollbar,body::-webkit-scrollbar{display:none;}';
        iDoc.head.appendChild(scrollStyle);

        /* Inject editing styles */
        var style = iDoc.createElement('style');
        style.textContent =
          '[data-admin-editable]{cursor:pointer;transition:outline .2s,background .2s;border-radius:4px;}' +
          '[data-admin-editable]:hover{outline:2px dashed rgba(167,139,250,0.5);outline-offset:2px;}' +
          '[data-admin-editable]:focus{outline:2px solid rgba(167,139,250,0.8);outline-offset:2px;background:rgba(167,139,250,0.08);}' +
          '[data-admin-editable].admin-edited{outline:2px solid rgba(46,204,113,0.6);outline-offset:2px;}' +
          '[data-admin-account-editable]{cursor:pointer;transition:outline .2s,background .2s;border-radius:4px;}' +
          '[data-admin-account-editable]:hover{outline:2px dashed rgba(52,152,219,0.5);outline-offset:2px;}' +
          '[data-admin-account-editable]:focus{outline:2px solid rgba(52,152,219,0.8);outline-offset:2px;background:rgba(52,152,219,0.08);}' +
          '[data-admin-account-editable].admin-edited{outline:2px solid rgba(46,204,113,0.6);outline-offset:2px;}' +
          '';
        iDoc.head.appendChild(style);

        /* ── Scarcity badge dropdown (form page only) ── */
        if (iframeId === 'preview-form') {
          var scarcityLevels = ['모집중', '마감임박', '마감'];

          iDoc.querySelectorAll('[id^="scarcity-"]').forEach(function(badge) {
            var badgeId = badge.id;
            if (!badgeId) return;
            badge.setAttribute('data-admin-scarcity', badgeId);
            badge.style.pointerEvents = 'auto';
            badge.style.cursor = 'pointer';
            badge.style.position = 'relative';
            badge.style.zIndex = '10';

            badge.addEventListener('click', function(e) {
              e.preventDefault();
              e.stopPropagation();
              /* Show dropdown in parent (admin) page, not inside iframe */
              showScarcityDropdown(badge, badgeId, iframe);
            });
          });
        }

        /* Mark content editable fields */
        var contentIds = IFRAME_EDITABLE_MAP[iframeId] || [];
        contentIds.forEach(function(id) {
          var el = iDoc.getElementById(id);
          if (!el) return;
          el.setAttribute('contenteditable', 'true');
          el.setAttribute('data-admin-editable', id);
          el.setAttribute('title', '클릭하여 수정 (' + id + ')');

          el.addEventListener('focus', function() {
            el.classList.remove('admin-edited');
          });

          el.addEventListener('blur', function() {
            var newVal = el.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim();
            var hiddenField = document.getElementById(id);
            if (hiddenField) {
              hiddenField.value = newVal;
            }
            pendingChanges[id] = newVal;
            el.classList.add('admin-edited');
            updatePendingBadge();
          });

          el.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') { el.blur(); }
          });
        });

        /* Mark account editable fields */
        var accountIds = ACCOUNT_EDITABLE_MAP[iframeId] || {};
        Object.keys(accountIds).forEach(function(elId) {
          var el = iDoc.getElementById(elId);
          if (!el) return;
          el.setAttribute('contenteditable', 'true');
          el.setAttribute('data-admin-account-editable', elId);
          el.setAttribute('title', '클릭하여 수정 (계좌 정보)');

          el.addEventListener('focus', function() {
            el.classList.remove('admin-edited');
          });

          el.addEventListener('blur', function() {
            var newVal = el.textContent.trim();
            /* Strip prefix like "예금주: " */
            if (elId.indexOf('holder') !== -1) {
              newVal = newVal.replace(/^예금주:\s*/, '');
            }
            var accountKey = accountIds[elId];
            pendingAccountChanges[accountKey] = newVal;
            el.classList.add('admin-edited');
            updatePendingBadge();
          });

          el.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') { el.blur(); }
            if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
          });
        });

      } catch(e) {
        /* cross-origin or not loaded yet */
        /* cross-origin or not loaded yet */
      }
    }

    /* Scarcity dropdown rendered in admin page (not inside iframe) */
    function showScarcityDropdown(badge, badgeId, iframe) {
      var scarcityLevels = ['모집중', '마감임박', '마감'];
      /* Remove any existing dropdown */
      var existing = document.getElementById('admin-scarcity-dd');
      if (existing) { existing.remove(); return; }

      var currentLevel = badge.textContent.trim() || '모집중';

      var dropdown = document.createElement('div');
      dropdown.id = 'admin-scarcity-dd';
      dropdown.style.cssText = 'position:fixed;z-index:99999;background:#1e1e2e;border:1.5px solid rgba(167,139,250,0.4);border-radius:8px;padding:4px 0;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:100px;';

      scarcityLevels.forEach(function(level) {
        var opt = document.createElement('div');
        opt.style.cssText = 'padding:8px 16px;font-size:13px;color:#e0e0e0;cursor:pointer;transition:background .15s;white-space:nowrap;font-family:var(--font);';
        if (level === currentLevel) opt.style.cssText += 'color:#a78bfa;font-weight:700;';
        opt.textContent = level;

        opt.addEventListener('mouseenter', function() { opt.style.background = 'rgba(167,139,250,0.15)'; });
        opt.addEventListener('mouseleave', function() { opt.style.background = 'none'; });

        opt.addEventListener('click', function(ev) {
          ev.stopPropagation();
          badge.textContent = level;
          /* Update badge class using classList to preserve attributes */
          badge.classList.remove('scarcity', 'urgent', 'closed', 'available');
          if (level === '마감') {
            badge.classList.add('closed');
          } else if (level === '마감임박') {
            badge.classList.add('scarcity', 'urgent');
          } else {
            badge.classList.add('available');
          }
          badge.style.outline = '2px solid rgba(46,204,113,0.6)';
          badge.style.outlineOffset = '2px';
          setTimeout(function() { badge.style.outline = ''; badge.style.outlineOffset = ''; }, 2000);

          /* Track override */
          var dayName = badgeId.replace('scarcity-', '');
          pendingScarcityOverrides[dayName] = level;
          updatePendingBadge();
          dropdown.remove();
        });
        dropdown.appendChild(opt);
      });

      /* Calculate position: badge rect in iframe → transform to admin page coords */
      var badgeRect = badge.getBoundingClientRect();
      var iframeRect = iframe.getBoundingClientRect();
      var scale = iframeRect.width / (iframe.contentWindow.innerWidth || iframeRect.width);

      var left = iframeRect.left + (badgeRect.left * scale);
      var top = iframeRect.top + (badgeRect.bottom * scale) + 4;

      dropdown.style.left = left + 'px';
      dropdown.style.top = top + 'px';
      document.body.appendChild(dropdown);

      /* Close on click outside */
      var closeHandler = function(ev) {
        if (!dropdown.contains(ev.target)) {
          dropdown.remove();
          document.removeEventListener('click', closeHandler, true);
        }
      };
      setTimeout(function() { document.addEventListener('click', closeHandler, true); }, 10);
    }

    function updatePendingBadge() {
      var count = Object.keys(pendingChanges).length + Object.keys(pendingAccountChanges).length + Object.keys(pendingScarcityOverrides).length;
      var badge = document.getElementById('pending-badge');
      if (badge) {
        badge.textContent = count + '개 변경사항';
        badge.style.display = count > 0 ? 'inline' : 'none';
      }
    }

    /* Setup iframes on load */
    ['preview-main', 'preview-form', 'preview-complete'].forEach(function(iframeId) {
      var iframe = document.getElementById(iframeId);
      if (iframe) {
        iframe.addEventListener('load', function() {
          injectEditableOverlay(iframe, iframeId);
          /* Wait for iframe's own JS to finish fetching from API, then inject admin values and reveal */
          setTimeout(function() {
            injectSavedContentIntoIframe(iframe, iframeId);
            iframe.classList.add('ready');
          }, 1800);
        });
      }
    });

    function injectSavedContentIntoIframe(iframe, iframeId) {
      try {
        var iDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (!iDoc) return;
        var contentIds = IFRAME_EDITABLE_MAP[iframeId] || [];
        contentIds.forEach(function(id) {
          var hiddenField = document.getElementById(id);
          var iframeEl = iDoc.getElementById(id);
          if (hiddenField && hiddenField.value && iframeEl) {
            iframeEl.innerHTML = hiddenField.value.replace(/\n/g, '<br/>');
          }
        });
        /* Also re-inject pending account changes */
        var accountMap = ACCOUNT_EDITABLE_MAP[iframeId] || {};
        Object.keys(accountMap).forEach(function(elId) {
          var key = accountMap[elId];
          if (pendingAccountChanges[key]) {
            var el = iDoc.getElementById(elId);
            if (el) {
              el.textContent = (key === 'holder') ? '예금주: ' + pendingAccountChanges[key] : pendingAccountChanges[key];
            }
          }
        });
      } catch(e) { /* cross-origin */ }
    }

    /* Load account info into form/complete iframes */
    function loadAccountIntoIframes() {
      fetch(API_BASE + '/api/account')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(resp) {
        if (!resp) return;
        var acct = resp.account || resp;
        ['preview-form', 'preview-complete'].forEach(function(iframeId) {
          try {
            var iframe = document.getElementById(iframeId);
            var iDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (!iDoc) return;
            var accountMap = ACCOUNT_EDITABLE_MAP[iframeId] || {};
            Object.keys(accountMap).forEach(function(elId) {
              var el = iDoc.getElementById(elId);
              if (!el) return;
              var key = accountMap[elId];
              if (key === 'bank' && acct.bank) el.textContent = acct.bank;
              if (key === 'account_number' && acct.account_number) el.textContent = acct.account_number;
              if (key === 'holder' && acct.holder) el.textContent = '예금주: ' + acct.holder;
            });
          } catch(e) { /* cross-origin */ }
        });
      })
      .catch(function() {});
    }

    /* Extra settings (cta) - bind input to hidden + iframe sync */
    ['sticky-cta-text'].forEach(function(id) {
      var input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('input', function() {
        pendingChanges[id] = input.value;
        updatePendingBadge();
        try {
          var iframe = document.getElementById('preview-main');
          var iDoc = iframe.contentDocument || iframe.contentWindow.document;
          var iframeEl = iDoc.getElementById('sticky-cta-text');
          if (iframeEl) iframeEl.textContent = input.value;
        } catch(e) {}
      });
    });

    /* ============================================================
       PRICE PREVIEW
    ============================================================ */
    function updatePricePreview() {
      var items = [];
      _branches.forEach(function(b) {
        var p2base = b.part2_base != null ? b.part2_base : 18000;
        var p2disc = b.part2_discount != null ? b.part2_discount : 10;
        var rate = 1 - p2disc / 100;
        items.push({ label: b.name + ' 남 1부', val: b.male });
        items.push({ label: b.name + ' 여 1부', val: b.female });
        items.push({ label: b.name + ' 남 1+2부 선결제 (' + p2disc + '%↓)', val: Math.round((b.male + p2base) * rate) });
        items.push({ label: b.name + ' 여 1+2부 선결제 (' + p2disc + '%↓)', val: Math.round((b.female + p2base) * rate) });
      });
      document.getElementById('price-preview-grid').innerHTML = items.map(function(it) {
        return '<div class="price-preview-item"><span class="price-preview-label">' + it.label +
          '</span><span class="price-preview-val">' + it.val.toLocaleString() + '원</span></div>';
      }).join('');
    }

    /* ============================================================
       MOBILE BOTTOM NAV + MORE MENU
    ============================================================ */
    document.querySelectorAll('.bottom-nav-btn[data-target]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var target = btn.getAttribute('data-target');
        if (target === 'sec-more') {
          document.getElementById('more-menu-overlay').style.display = 'flex';
          return;
        }
        document.getElementById('more-menu-overlay').style.display = 'none';
        switchSection(target);
        // Update bottom nav active state
        document.querySelectorAll('.admin-bottom-nav .bottom-nav-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.admin-bottom-nav .bottom-nav-btn[data-target="' + target + '"]').forEach(function(b) { b.classList.add('active'); });
      });
    });

    document.getElementById('more-menu-close').addEventListener('click', function() {
      document.getElementById('more-menu-overlay').style.display = 'none';
    });
    document.getElementById('more-menu-overlay').addEventListener('click', function(e) {
      if (e.target === this) this.style.display = 'none';
    });

    // More menu items switch section and close overlay
    document.querySelectorAll('#more-menu-overlay .bottom-nav-btn[data-target]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var target = btn.getAttribute('data-target');
        document.getElementById('more-menu-overlay').style.display = 'none';
        switchSection(target);
        document.querySelectorAll('.admin-bottom-nav .bottom-nav-btn').forEach(function(b) { b.classList.remove('active'); });
      });
    });

    function bindSettings() {
      document.getElementById('save-account-btn').addEventListener('click', saveAccountInfo);
      document.getElementById('pw-form').addEventListener('submit', function(e) {
        e.preventDefault();
        var cur  = document.getElementById('pw-current').value;
        var nw   = document.getElementById('pw-new').value;
        var conf = document.getElementById('pw-confirm').value;
        var msg  = document.getElementById('pw-msg');

        msg.className = 'settings-msg';

        if (!cur || !nw || !conf) {
          msg.textContent = '모든 항목을 입력해 주세요.';
          msg.className = 'settings-msg err';
          return;
        }
        if (nw !== conf) {
          msg.textContent = '새 비밀번호가 일치하지 않습니다.';
          msg.className = 'settings-msg err';
          return;
        }

        fetch(API_BASE + '/api/admin/password', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ currentPassword: cur, newPassword: nw })
        })
        .then(function(r) {
          if (!r.ok) throw new Error('pw_fail');
          msg.textContent = '비밀번호가 변경되었습니다. 다시 로그인해 주세요.';
          msg.className = 'settings-msg ok';
          document.getElementById('pw-form').reset();
          setTimeout(handleLogout, 2000);
        })
        .catch(function() {
          msg.textContent = '현재 비밀번호가 올바르지 않거나 변경에 실패했습니다.';
          msg.className = 'settings-msg err';
        });
      });
    }
