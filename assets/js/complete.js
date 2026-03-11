/* =============================================
   COMPLETE PAGE — depends on common.js (API_BASE, esc, fmtPrice, revealPage)
   ============================================= */

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

function fmtGender(g) { return g === 'male' ? '남성' : g === 'female' ? '여성' : g; }

/* Load pricing from API then render */
(async function() {
  try {
    const res = await fetch(API_BASE + '/api/site-content');
    if (res.ok) {
      const apiData = await res.json();
      const raw = (apiData.content || {}).pricing;
      if (raw) {
        const pricing = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const newPrices = {};
        var globalP2Base = pricing.part2_base ? Number(pricing.part2_base) : 18000;
        var globalP2Disc = pricing.part2_discount ? Number(pricing.part2_discount) : 10;
        PART2_BASE = globalP2Base;
        PART2_DISCOUNT = globalP2Disc;
        Object.keys(pricing).forEach(key => {
          if (key === 'part2_base' || key === 'part2_discount') return;
          const p = pricing[key];
          newPrices[key] = {
            male: Number(p.male), female: Number(p.female),
            part2_base: p.part2_base != null ? Number(p.part2_base) : globalP2Base,
            part2_discount: p.part2_discount != null ? Number(p.part2_discount) : globalP2Disc
          };
        });
        if (Object.keys(newPrices).length > 0) PRICES = newPrices;
      }
    }
  } catch { /* use defaults */ }
  renderComplete();
})();

function renderComplete() {
if (data) {
  /* totalPrice가 있으면 할인 적용된 최종가 사용, 없으면 기존 방식으로 계산 */
  let displayPrice;
  if (data.totalPrice != null && data.totalPrice > 0) {
    displayPrice = data.totalPrice;
  } else {
    const price = data.price || (PRICES[data.branch] && PRICES[data.branch][data.gender]) || 0;
    if (data.part2pay === 'prepay') {
      const bp = PRICES[data.branch];
      const p2b = bp && bp.part2_base != null ? bp.part2_base : PART2_BASE;
      const p2d = bp && bp.part2_discount != null ? bp.part2_discount : PART2_DISCOUNT;
      displayPrice = Math.round((price + p2b) * (1 - p2d / 100));
    } else {
      displayPrice = price;
    }
  }

  document.getElementById('payment-amount').textContent = fmtPrice(displayPrice);

  /* Summary rows — built with DOM API (XSS-safe) */
  const rows = [
    { key: '이름', val: data.name },
    { key: '나이', val: data.age + '세' },
    { key: '연락처', val: data.phone },
    { key: '성별', val: fmtGender(data.gender) },
    { key: '지점', val: data.branch + '점' },
    { key: '날짜', val: data.date },
    ...(data.part2pay ? [{ key: '2부참여', val: data.part2pay === 'prepay' ? '사전결제' : data.part2pay === 'onsite' ? '현장결제' : data.part2pay }] : []),
    ...(data.discount ? [{ key: '할인코드', val: data.discount }] : []),
    ...(data.discountAmount > 0 ? [{ key: '할인금액', val: '-' + fmtPrice(data.discountAmount) }] : []),
    { key: '참가비', val: fmtPrice(displayPrice) },
  ];

  const body = document.getElementById('summary-body');
  body.innerHTML = '';
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const keySpan = document.createElement('span');
    keySpan.className = 'summary-key';
    keySpan.textContent = r.key;
    const valSpan = document.createElement('span');
    valSpan.className = 'summary-val';
    valSpan.textContent = r.val ?? '—';
    row.appendChild(keySpan);
    row.appendChild(valSpan);
    body.appendChild(row);
  });
} else {
  document.getElementById('payment-amount').textContent = '신청 정보 확인 필요';
}
} /* end renderComplete */

/* =============================================
   DYNAMIC SITE CONTENT FROM ADMIN
   ============================================= */
async function loadSiteContent() {
  try {
    const res = await fetch(API_BASE + '/api/site-content');
    if (!res.ok) return;
    const data = await res.json();
    const content = data.content || {};
    Object.entries(content).forEach(([key, val]) => {
      if (!val || !key.startsWith('complete-')) return;
      const el = document.getElementById(key);
      if (el) el.innerHTML = esc(val).replace(/\n/g, '<br/>');
    });
  } catch { /* no backend */ }
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
    const bankEl = document.getElementById('complete-bank-name');
    const accountEl = document.getElementById('account-number');
    const holderEl = document.getElementById('complete-account-holder');
    if (bank && bankEl) bankEl.textContent = bank;
    if (account_number && accountEl) accountEl.textContent = account_number;
    if (holder && holderEl) holderEl.textContent = '예금주: ' + holder;
  } catch { /* no backend */ }
}

/* Load all dynamic data, then reveal page */
var _apiDone = Promise.all([loadSiteContent(), loadAccountInfo()]);
var _timeout = new Promise(function(r) { setTimeout(r, 800); });
Promise.race([_apiDone, _timeout]).then(revealPage);
_apiDone.finally(revealPage);

/* =============================================
   COPY ACCOUNT
   ============================================= */
function copyAccount() {
  const account = document.getElementById('account-number').textContent;
  navigator.clipboard.writeText(account).then(() => {
    const btn = document.getElementById('copy-account-btn');
    const orig = btn.innerHTML;
    btn.textContent = '✓ 복사됨';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }).catch(() => {});
}

/* =============================================
   INSTAGRAM ID (dynamic from API)
   ============================================= */
(async function() {
  try {
    const res = await fetch(API_BASE + '/api/scarcity');
    if (!res.ok) return;
    const data = await res.json();
    if (data.instagram_id) {
      const link = document.querySelector('.btn-instagram');
      if (link) {
        link.href = 'https://www.instagram.com/' + encodeURIComponent(data.instagram_id);
        const textNode = link.childNodes;
        for (let i = 0; i < textNode.length; i++) {
          if (textNode[i].nodeType === 3 && textNode[i].textContent.includes('@')) {
            textNode[i].textContent = textNode[i].textContent.replace(/@[\w.]+/, '@' + data.instagram_id);
            break;
          }
        }
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
      text: '나도 ODD PARTY 신청했어! 같이 가자',
      url: location.origin + '/index.html'
    }).catch(() => {});
  } else {
    navigator.clipboard.writeText(location.origin + '/index.html').then(() => {
      alert('링크가 복사되었습니다!');
    });
  }
}
