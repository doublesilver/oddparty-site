/* =============================================
   PRICE DATA
   ============================================= */
const PRICES = {
  '건대': { male: 35000, female: 25000 },
  '영등포': { male: 38000, female: 28000 },
};
const PART2_BASE = 18000;

function fmtPrice(n) {
  return n.toLocaleString('ko-KR') + '원';
}

function getPrice1() {
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  if (gender && branch && PRICES[branch]) return PRICES[branch][gender];
  return 0;
}

/* =============================================
   PRE-SELECT GENDER FROM URL PARAMS
   ============================================= */
/* Pre-select gender from URL params */
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
    if (joinPart2) {
      if (part2pay === 'prepay') {
        const total = Math.round((price1 + PART2_BASE) * 0.9);
        text.innerHTML = `<strong>${branch}점 1+2부 선결제</strong> · <span class="dynamic-price">${fmtPrice(total)}</span> <small style="color:var(--muted)">(10% 할인)</small>`;
      } else {
        text.innerHTML = `<strong>${branch}점 1부</strong> · <span class="dynamic-price">${fmtPrice(price1)}</span> + 2부 현장 18,000원`;
      }
    } else {
      text.innerHTML = `<strong>${branch}점</strong> · <span class="dynamic-price">${fmtPrice(price1)}</span>`;
    }
  } else if (gender && !branch) {
    text.innerHTML = `지점을 선택하면 가격이 표시됩니다.`;
  } else {
    text.innerHTML = `성별을 선택하면 가격이 표시됩니다.`;
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
    const prepayTotal = Math.round((price1 + PART2_BASE) * 0.9);
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
    btn.innerHTML = '✓ 복사됨';
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
  const birthyear = parseInt(document.getElementById('field-birthyear').value);
  const phone = document.getElementById('field-phone').value.trim();
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const date = document.querySelector('input[name="date"]:checked')?.value;
  const discount = document.getElementById('field-discount').value.trim();
  const joinPart2 = document.getElementById('joinPart2').checked;
  const part2pay = joinPart2 ? (document.querySelector('input[name="part2pay"]:checked')?.value || 'prepay') : null;

  showError('err-name', !name);
  if (!name) valid = false;

  showError('err-age', !birthyear || birthyear < 1986 || birthyear > 2005);
  if (!birthyear || birthyear < 1986 || birthyear > 2005) valid = false;

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

  if (joinPart2) {
    if (part2pay === 'prepay') {
      totalPrice = Math.round((price1 + PART2_BASE) * 0.9);
      part2Amount = totalPrice - price1;
    } else {
      part2Amount = PART2_BASE;
    }
  }

  const formData = {
    name,
    birthyear,
    age: new Date().getFullYear() - parseInt(birthyear),
    phone,
    gender,
    branch,
    date,
    discount,
    price: price1,
    joinPart2,
    part2pay: part2pay || null,
    totalPrice,
    part2Amount,
  };

  sessionStorage.setItem('odd_party_data', JSON.stringify(formData));

  try {
    await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });
  } catch {
    /* No backend — continue gracefully */
  }

  window.location.href = 'complete.html';
});
