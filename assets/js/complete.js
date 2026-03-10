/* =============================================
   LOAD & RENDER SESSION DATA
   ============================================= */
const raw = sessionStorage.getItem('odd_party_data');
const data = raw ? JSON.parse(raw) : null;

let PRICES = {
  '건대': { male: 33000, female: 23000 },
  '영등포': { male: 39500, female: 29500 },
};
let PART2_BASE = 18000;
let PART2_DISCOUNT = 10;

function fmtPrice(n) { return n?.toLocaleString('ko-KR') + '원'; }
function fmtGender(g) { return g === 'male' ? '남성' : g === 'female' ? '여성' : g; }

/* Load pricing from API then render */
(async function() {
  try {
    const res = await fetch('https://oddparty-api-production.up.railway.app/api/site-content');
    if (res.ok) {
      const apiData = await res.json();
      const raw = (apiData.content || {}).pricing;
      if (raw) {
        const pricing = typeof raw === 'string' ? JSON.parse(raw) : raw;
        ['건대', '영등포'].forEach(branch => {
          if (pricing[branch]) PRICES[branch] = { male: Number(pricing[branch].male), female: Number(pricing[branch].female) };
        });
        if (pricing.part2_base) PART2_BASE = Number(pricing.part2_base);
        if (pricing.part2_discount) PART2_DISCOUNT = Number(pricing.part2_discount);
      }
    }
  } catch { /* use defaults */ }
  renderComplete();
})();

function renderComplete() {
if (data) {
  /* Payment amount */
  const price = data.price || (PRICES[data.branch] && PRICES[data.branch][data.gender]) || 0;

  let displayPrice;
  if (data.part2pay === 'prepay') {
    displayPrice = Math.round((price + PART2_BASE) * (1 - PART2_DISCOUNT / 100));
  } else if (data.part2pay === 'onsite') {
    displayPrice = price;
  } else {
    displayPrice = price;
  }

  document.getElementById('payment-amount').textContent = fmtPrice(displayPrice);

  /* Summary rows */
  const rows = [
    { key: '이름', val: data.name },
    { key: '나이', val: data.age + '세' },
    { key: '연락처', val: data.phone },
    { key: '성별', val: fmtGender(data.gender) },
    { key: '지점', val: data.branch + '점' },
    { key: '날짜', val: data.date },
    ...(data.part2pay ? [{ key: '2부참여', val: data.part2pay === 'prepay' ? '사전결제' : data.part2pay === 'onsite' ? '현장결제' : data.part2pay }] : []),
    ...(data.discount ? [{ key: '할인코드', val: data.discount }] : []),
    { key: '참가비', val: fmtPrice(displayPrice) },
  ];

  const body = document.getElementById('summary-body');
  body.innerHTML = rows.map(r => `
    <div class="summary-row">
      <span class="summary-key">${r.key}</span>
      <span class="summary-val">${r.val ?? '—'}</span>
    </div>
  `).join('');
} else {
  document.getElementById('payment-amount').textContent = '신청 정보 확인 필요';
}
} /* end renderComplete */

/* =============================================
   DYNAMIC SITE CONTENT FROM ADMIN
   ============================================= */
(async function loadSiteContent() {
  try {
    const res = await fetch('https://oddparty-api-production.up.railway.app/api/site-content');
    if (!res.ok) return;
    const data = await res.json();
    const content = data.content || {};
    Object.entries(content).forEach(([key, val]) => {
      if (!val || !key.startsWith('complete-')) return;
      const el = document.getElementById(key);
      if (el) el.innerHTML = val.replace(/\n/g, '<br/>');
    });
  } catch { /* no backend */ }
})();

/* =============================================
   ACCOUNT INFO (dynamic from API)
   ============================================= */
(async function loadAccountInfo() {
  try {
    const res = await fetch('https://oddparty-api-production.up.railway.app/api/account');
    if (!res.ok) return;
    const data = await res.json();
    const { bank, account_number, holder } = data.account || data;
    const bankEl = document.getElementById('complete-bank-name');
    const accountEl = document.getElementById('account-number');
    const holderEl = document.getElementById('complete-account-holder');
    if (bank && bankEl) bankEl.textContent = bank;
    if (account_number && accountEl) accountEl.textContent = account_number;
    if (holder && holderEl) holderEl.textContent = '예금주: ' + holder;
  } catch { /* no backend — keep default values */ }
})();

/* =============================================
   COPY ACCOUNT
   ============================================= */
function copyAccount() {
  const account = document.getElementById('account-number').textContent;
  navigator.clipboard.writeText(account).then(() => {
    const btn = document.getElementById('copy-account-btn');
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ 복사됨';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }).catch(() => {});
}

/* =============================================
   INSTAGRAM ID (dynamic from API)
   ============================================= */
(async function() {
  try {
    const res = await fetch('https://oddparty-api-production.up.railway.app/api/scarcity');
    if (!res.ok) return;
    const data = await res.json();
    if (data.instagram_id) {
      const link = document.querySelector('.btn-instagram');
      if (link) {
        link.href = 'https://www.instagram.com/' + data.instagram_id;
        link.innerHTML = link.innerHTML.replace(/@[\w.]+/, '@' + data.instagram_id);
      }
    }
  } catch { /* no backend */ }
})();

/* =============================================
   SHARE
   ============================================= */
function sharePage() {
  if (navigator.share) {
    navigator.share({
      title: 'ODD PARTY — 낯선 사람들이 만나는 밤',
      text: '나도 ODD PARTY 신청했어! 같이 가자 🎉',
      url: location.origin + '/index.html'
    }).catch(() => {});
  } else {
    navigator.clipboard.writeText(location.origin + '/index.html').then(() => {
      alert('링크가 복사되었습니다!');
    });
  }
}
