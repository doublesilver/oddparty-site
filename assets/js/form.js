/* =============================================
   FORM PAGE — depends on common.js (API_BASE, esc, fmtPrice, revealPage)
   ============================================= */

/* =============================================
   DATE LABELS — show "13일(금)" format
   ============================================= */
(function setDateLabels() {
  var now = new Date();
  var day = now.getDay(); // 0=Sun .. 5=Fri 6=Sat
  var daysUntilFri = (5 - day + 7) % 7;
  // 일요일 19시 이후 다음 주로 전환
  if (day === 6) daysUntilFri = -1;
  if (day === 0 && now.getHours() < 19) daysUntilFri = -2;
  var fri = new Date(now); fri.setDate(now.getDate() + daysUntilFri);
  var sat = new Date(fri); sat.setDate(fri.getDate() + 1);
  var sun = new Date(fri); sun.setDate(fri.getDate() + 2);

  var map = { '금요일': fri, '토요일': sat, '일요일': sun };
  var shortDay = { '금요일': '금', '토요일': '토', '일요일': '일' };

  Object.entries(map).forEach(function(entry) {
    var key = entry[0], d = entry[1];
    var label = document.getElementById('date-label-' + key);
    var sub = document.getElementById('date-sub-' + key);
    if (label) label.textContent = d.getDate() + '일(' + shortDay[key] + ')';
    if (sub) sub.textContent = (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  });
})();

/* =============================================
   SCARCITY BADGES (dynamic from API)
   ============================================= */
async function loadScarcity() {
  try {
    const res = await fetch(API_BASE + '/api/scarcity');
    if (!res.ok) return;
    const data = await res.json();
    const dates = data.dates || {};
    Object.entries(dates).forEach(([day, info]) => {
      const badge = document.getElementById('scarcity-' + day);
      if (!badge) return;
      const label = badge.closest('.radio-card-label');
      if (info.level === '마감') {
        badge.textContent = '마감';
        badge.className = 'radio-card-badge closed';
        if (label) {
          label.classList.add('disabled');
          const input = label.querySelector('input');
          if (input) input.disabled = true;
        }
      } else if (info.level === '마감임박') {
        badge.textContent = '마감임박';
        badge.className = 'radio-card-badge scarcity urgent';
      } else {
        badge.textContent = '모집중';
        badge.className = 'radio-card-badge available';
      }
    });
  } catch { /* no backend — badges stay empty */ }
}

/* =============================================
   DYNAMIC SITE CONTENT + PRICING (single fetch)
   ============================================= */
async function loadSiteContentAndPricing() {
  try {
    const res = await fetch(API_BASE + '/api/site-content');
    if (!res.ok) return;
    const data = await res.json();
    const content = data.content || {};

    /* Apply text content (sanitized) */
    Object.entries(content).forEach(([key, val]) => {
      if (!val || !key.startsWith('form-')) return;
      const el = document.getElementById(key);
      if (el) el.innerHTML = esc(val).replace(/\n/g, '<br/>');
    });

    /* Load pricing from same response */
    const raw = content.pricing;
    if (!raw) return;
    const pricing = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const newPrices = {};
    /* 글로벌 폴백값 */
    var globalP2Base = pricing.part2_base ? Number(pricing.part2_base) : 18000;
    var globalP2Disc = pricing.part2_discount ? Number(pricing.part2_discount) : 10;
    PART2_BASE = globalP2Base;
    PART2_DISCOUNT = globalP2Disc;
    Object.keys(pricing).forEach(key => {
      if (key === 'part2_base' || key === 'part2_discount') return;
      const p = pricing[key];
      newPrices[key] = {
        male: Number(p.male), female: Number(p.female), note: p.note || '',
        part2_base: p.part2_base != null ? Number(p.part2_base) : globalP2Base,
        part2_discount: p.part2_discount != null ? Number(p.part2_discount) : globalP2Disc
      };
    });
    if (Object.keys(newPrices).length > 0) PRICES = newPrices;

    renderBranchCards();
    updateBranchPriceLabels();
    updatePart2PrepayPrice();
    updatePrice();
  } catch { /* use defaults */ }
}

/* =============================================
   ACCOUNT INFO (dynamic from API)
   ============================================= */
async function loadAccountInfo() {
  try {
    const res = await fetch(API_BASE + '/api/account');
    if (!res.ok) return;
    const data = await res.json();
    const { bank, account_number, holder } = data.account || data;
    const bankEl = document.getElementById('form-bank-name');
    const accountEl = document.getElementById('account-number');
    const holderEl = document.getElementById('form-account-holder');
    const noteBank = document.getElementById('form-submit-note-bank');
    const noteAccount = document.getElementById('form-submit-note-account');
    const noteHolder = document.getElementById('form-submit-note-holder');
    if (bank) {
      if (bankEl) bankEl.textContent = bank;
      if (noteBank) noteBank.textContent = bank;
    }
    if (account_number) {
      if (accountEl) accountEl.textContent = account_number;
      if (noteAccount) noteAccount.textContent = account_number;
    }
    if (holder) {
      if (holderEl) holderEl.textContent = '예금주: ' + holder;
      if (noteHolder) noteHolder.textContent = holder;
    }
  } catch { /* no backend */ }
}

/* =============================================
   PARTY DATES (from admin — replaces defaults when set)
   ============================================= */
async function loadPartyDates() {
  try {
    const res = await fetch(API_BASE + '/api/party-dates');
    if (!res.ok) return;
    const data = await res.json();
    const dates = data.dates || [];
    if (dates.length === 0) return;

    const grid = document.getElementById('date-radio-grid');
    if (!grid) return;

    /* Admin이 날짜를 설정했으면 기본 금/토/일 대신 전체 교체 */
    grid.innerHTML = '';

    dates.forEach(function(d) {
      var value = d.label || d.date;

      var label = document.createElement('label');
      label.className = 'radio-card-label';
      var input = document.createElement('input');
      input.className = 'radio-card-input';
      input.type = 'radio';
      input.name = 'date';
      input.value = value;
      label.appendChild(input);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'radio-card-name';
      nameSpan.textContent = value;
      label.appendChild(nameSpan);

      var subSpan = document.createElement('span');
      subSpan.className = 'radio-card-sub';
      subSpan.textContent = d.dayName || '';
      label.appendChild(subSpan);

      var badgeSpan = document.createElement('span');
      badgeSpan.className = 'radio-card-badge available';
      badgeSpan.id = 'scarcity-' + (d.dayName || value);
      badgeSpan.textContent = '모집중';
      label.appendChild(badgeSpan);

      grid.appendChild(label);
    });

    var count = grid.querySelectorAll('.radio-card-label').length;
    grid.className = 'radio-grid radio-grid-' + Math.min(count, 4);
    initRadioCards('date');
  } catch { /* no custom dates — keep defaults */ }
}

/* Load all dynamic data, then reveal page */
var _apiDone = Promise.all([loadSiteContentAndPricing(), loadAccountInfo(), loadPartyDates()]).then(function() { return loadScarcity(); });
var _timeout = new Promise(function(r) { setTimeout(r, 800); });
Promise.race([_apiDone, _timeout]).then(revealPage);
_apiDone.finally(function() {
  revealPage();
  /* URL 파라미터로 지점 자동 선택 */
  var params = new URLSearchParams(location.search);
  var preselect = params.get('branch');
  if (preselect) {
    var input = document.querySelector('input[name="branch"][value="' + CSS.escape(preselect) + '"]');
    if (input) {
      input.checked = true;
      input.closest('.radio-card-label')?.classList.add('selected');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      /* 지점 영역으로 스크롤 */
      var section = input.closest('.form-group');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
});

/* =============================================
   PRICE DATA (loaded from API, fallback to defaults)
   ============================================= */
let PRICES = {
  '건대': { male: 33000, female: 23000, note: '포틀럭 포함' },
  '영등포': { male: 39500, female: 29500, note: '안주 포함' },
};
let PART2_BASE = 18000;
let PART2_DISCOUNT = 10;

function getBranchNames() {
  return Object.keys(PRICES);
}

function renderBranchCards() {
  const grid = document.getElementById('branch-radio-grid');
  if (!grid) return;
  const names = getBranchNames();
  const count = names.length;
  grid.className = 'radio-grid radio-grid-' + Math.min(count, 4);
  grid.innerHTML = '';
  names.forEach(function(branch) {
    var p = PRICES[branch];
    var label = document.createElement('label');
    label.className = 'radio-card-label';

    var input = document.createElement('input');
    input.className = 'radio-card-input';
    input.type = 'radio';
    input.name = 'branch';
    input.value = branch;
    label.appendChild(input);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'radio-card-name';
    nameSpan.textContent = '\uD83C\uDFE2 ' + branch;
    label.appendChild(nameSpan);

    var subSpan = document.createElement('span');
    subSpan.className = 'radio-card-sub';
    subSpan.id = 'branch-price-' + branch;
    subSpan.textContent = '남 ' + fmtPrice(p.male) + ' / 여 ' + fmtPrice(p.female);
    label.appendChild(subSpan);

    grid.appendChild(label);
  });
  initRadioCards('branch');
}

/* Render default branch cards immediately */
renderBranchCards();

function getPrice1() {
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  if (gender && branch && PRICES[branch]) return PRICES[branch][gender];
  return 0;
}

/* =============================================
   PRE-SELECT GENDER FROM URL PARAMS
   ============================================= */
const urlParams = new URLSearchParams(window.location.search);
const preGender = urlParams.get('gender');
if (preGender) {
  const radio = document.getElementById('gender-' + preGender);
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/* =============================================
   RADIO CARD ACTIVATION
   ============================================= */
function initRadioCards(groupName) {
  const inputs = document.querySelectorAll(`input[name="${groupName}"]`);
  inputs.forEach(input => {
    const label = input.closest('.radio-card-label');
    if (!label) return;
    if (input.checked) label.classList.add('selected');
    input.addEventListener('change', () => {
      inputs.forEach(i => i.closest('.radio-card-label')?.classList.remove('selected'));
      label.classList.add('selected');
      if (groupName === 'gender' || groupName === 'branch') {
        updateBranchPriceLabels();
        updatePrice();
      }
      if (groupName === 'branch') onBranchChange();
      if (groupName === 'part2pay') {
        updatePart2PrepayPrice();
        updatePrice();
      }
    });
  });
}
['gender', 'branch', 'date', 'part2pay'].forEach(initRadioCards);

/* =============================================
   GET BRANCH-SPECIFIC PART2 VALUES
   ============================================= */
function getBranchPart2() {
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const bp = branch && PRICES[branch];
  return {
    base: bp && bp.part2_base != null ? bp.part2_base : PART2_BASE,
    discount: bp && bp.part2_discount != null ? bp.part2_discount : PART2_DISCOUNT
  };
}

/* =============================================
   UPDATE BRANCH PRICE LABELS
   ============================================= */
function updateBranchPriceLabels() {
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  Object.keys(PRICES).forEach(branch => {
    const el = document.getElementById(`branch-price-${branch}`);
    if (!el) return;
    if (gender) {
      el.textContent = fmtPrice(PRICES[branch][gender]);
    } else {
      el.textContent = `남 ${fmtPrice(PRICES[branch].male)} / 여 ${fmtPrice(PRICES[branch].female)}`;
    }
  });
}

/* =============================================
   KEYBOARD ACCESSIBLE RADIO CARDS
   ============================================= */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const label = e.target.closest('.radio-card-label:not(.disabled)');
  if (!label) return;
  e.preventDefault();
  label.querySelector('input')?.click();
});

/* =============================================
   DYNAMIC PRICE UPDATE
   ============================================= */
function updatePrice() {
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const joinPart2 = document.getElementById('joinPart2')?.checked;
  const part2pay = document.querySelector('input[name="part2pay"]:checked')?.value;
  const box = document.getElementById('price-box');
  const text = document.getElementById('price-box-text');

  if (!gender && !branch) { box.style.display = 'none'; return; }
  box.style.display = 'block';

  if (gender && branch) {
    const price1 = PRICES[branch][gender];
    const branchEsc = esc(branch);
    const p2 = getBranchPart2();
    if (joinPart2) {
      if (part2pay === 'prepay') {
        const total = Math.round((price1 + p2.base) * (1 - p2.discount / 100));
        text.innerHTML = `<strong>${branchEsc}점 1+2부 선결제</strong> · <span class="dynamic-price">${fmtPrice(total)}</span> <small style="color:var(--muted)">(${p2.discount}% 할인)</small>`;
      } else {
        text.innerHTML = `<strong>${branchEsc}점 1부</strong> · <span class="dynamic-price">${fmtPrice(price1)}</span> + 2부 현장 ${fmtPrice(p2.base)}`;
      }
    } else {
      text.innerHTML = `<strong>${branchEsc}점</strong> · <span class="dynamic-price">${fmtPrice(price1)}</span>`;
    }
  } else if (gender && !branch) {
    text.textContent = '지점을 선택하면 가격이 표시됩니다.';
  } else {
    text.textContent = '성별을 선택하면 가격이 표시됩니다.';
  }
}

/* =============================================
   2부 OPTIONS
   ============================================= */
function onBranchChange() {
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const part2Options = document.getElementById('part2Options');
  if (branch) {
    part2Options.style.display = 'block';
  } else {
    part2Options.style.display = 'none';
  }
  updatePart2PrepayPrice();
}

function updatePart2PrepayPrice() {
  const price1 = getPrice1();
  const priceEl = document.getElementById('part2PrepayPrice');
  if (!priceEl) return;
  if (price1 > 0) {
    const p2 = getBranchPart2();
    const prepayTotal = Math.round((price1 + p2.base) * (1 - p2.discount / 100));
    priceEl.textContent = fmtPrice(prepayTotal);
  } else {
    priceEl.textContent = '성별·지점 선택 후';
  }
}

document.getElementById('joinPart2').addEventListener('change', function () {
  const part2Methods = document.getElementById('part2Methods');
  part2Methods.style.display = this.checked ? 'block' : 'none';
  if (this.checked) {
    updatePart2PrepayPrice();
    initRadioCards('part2pay');
  }
  updatePrice();
});

/* =============================================
   COPY ACCOUNT
   ============================================= */
document.getElementById('copy-account-btn').addEventListener('click', function () {
  const account = document.getElementById('account-number').textContent;
  navigator.clipboard.writeText(account).then(() => {
    const btn = this;
    const orig = btn.innerHTML;
    btn.textContent = '✓ 복사됨';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }).catch(() => {});
});

/* =============================================
   PHONE AUTO FORMAT
   ============================================= */
const phoneInput = document.getElementById('field-phone');
phoneInput.addEventListener('input', () => {
  let v = phoneInput.value.replace(/\D/g, '').slice(0, 11);
  if (v.length > 7) v = v.slice(0, 3) + '-' + v.slice(3, 7) + '-' + v.slice(7);
  else if (v.length > 3) v = v.slice(0, 3) + '-' + v.slice(3);
  phoneInput.value = v;
});

/* =============================================
   FORM VALIDATION & SUBMIT
   ============================================= */
function showError(id, show) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('show', show);
}

document.getElementById('party-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let valid = true;

  const name = document.getElementById('field-name').value.trim();
  const age = parseInt(document.getElementById('field-age').value);
  const phone = document.getElementById('field-phone').value.trim();
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const date = document.querySelector('input[name="date"]:checked')?.value;
  const discount = document.getElementById('field-discount').value.trim();
  const joinPart2 = document.getElementById('joinPart2').checked;
  const part2pay = joinPart2 ? (document.querySelector('input[name="part2pay"]:checked')?.value || 'prepay') : null;

  showError('err-name', !name);
  if (!name) valid = false;

  showError('err-age', !age || age < 20 || age > 37);
  if (!age || age < 20 || age > 37) valid = false;

  showError('err-phone', !phone || phone.replace(/\D/g, '').length < 10);
  if (!phone || phone.replace(/\D/g, '').length < 10) valid = false;

  showError('err-gender', !gender);
  if (!gender) valid = false;

  showError('err-branch', !branch);
  if (!branch) valid = false;

  showError('err-date', !date);
  if (!date) valid = false;

  if (!valid) {
    const firstErr = document.querySelector('.field-error.show');
    firstErr?.closest('.field-group, .text-input-row')?.querySelector('input')?.focus();
    firstErr?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  /* Submit */
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.classList.add('loading');

  const price1 = getPrice1();
  let totalPrice = price1;
  let part2Amount = null;

  const p2 = getBranchPart2();
  if (joinPart2) {
    if (part2pay === 'prepay') {
      totalPrice = Math.round((price1 + p2.base) * (1 - p2.discount / 100));
      part2Amount = totalPrice - price1;
    } else {
      part2Amount = p2.base;
    }
  }

  /* Validate discount code if entered */
  let discountAmount = 0;
  if (discount) {
    try {
      const vRes = await fetch(API_BASE + '/api/discount/validate?code=' + encodeURIComponent(discount));
      if (vRes.ok) {
        const vData = await vRes.json();
        if (vData.valid) {
          if (vData.discount_type === 'percent') {
            discountAmount = Math.round(totalPrice * vData.discount_value / 100);
          } else {
            discountAmount = vData.discount_value || 0;
          }
          totalPrice = Math.max(0, totalPrice - discountAmount);
        } else {
          btn.disabled = false;
          btn.classList.remove('loading');
          showError('err-discount', true);
          return;
        }
      }
    } catch {
      /* Backend unreachable — proceed without validation */
    }
  }

  const formData = {
    name,
    age,
    phone,
    gender,
    branch,
    date,
    discount,
    discountAmount,
    price: price1,
    joinPart2,
    part2pay: part2pay || null,
    totalPrice,
    part2Amount,
  };

  sessionStorage.setItem('odd_party_data', JSON.stringify(formData));

  try {
    await fetch(API_BASE + '/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });
  } catch {
    /* No backend — continue gracefully */
  }

  window.location.href = 'complete.html';
});
