/* --- Sticky CTA visibility --- */
const hero = document.getElementById('hero');
const stickyCta = document.getElementById('sticky-cta');

const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    stickyCta.classList.toggle('visible', !e.isIntersecting);
  });
}, { threshold: 0.1 });
if (hero) observer.observe(hero);

/* --- FAQ accordion --- */
document.querySelectorAll('.faq-q').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
    });
    if (!isOpen) {
      item.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  });
});

/* --- Gallery drag scroll & dots --- */
const track = document.getElementById('gallery-track');
const dots = document.querySelectorAll('.gallery-dot');

if (track) {
  let isDragging = false, startX = 0, scrollLeft = 0;

  track.addEventListener('mousedown', e => {
    isDragging = true; startX = e.pageX - track.offsetLeft; scrollLeft = track.scrollLeft;
  });
  document.addEventListener('mouseup', () => isDragging = false);
  document.addEventListener('mousemove', e => {
    if (!isDragging) return; e.preventDefault();
    const x = e.pageX - track.offsetLeft;
    track.scrollLeft = scrollLeft - (x - startX) * 1.2;
  });

  function updateDots() {
    const cards = track.querySelectorAll('.gallery-card');
    const scrollPos = track.scrollLeft;
    const cardW = cards[0]?.offsetWidth + 12 || 1;
    const idx = Math.round(scrollPos / cardW);
    dots.forEach((d, i) => {
      d.classList.toggle('active', i === idx);
      d.setAttribute('aria-selected', i === idx ? 'true' : 'false');
    });
  }
  track.addEventListener('scroll', updateDots, { passive: true });
  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => {
      const cards = track.querySelectorAll('.gallery-card');
      const cardW = cards[0]?.offsetWidth + 12 || 0;
      track.scrollTo({ left: cardW * i, behavior: 'smooth' });
    });
  });
}

/* --- Gallery auto-slide --- */
if (track) {
  let autoSlideIdx = 0;
  const autoSlide = setInterval(() => {
    const cards = track.querySelectorAll('.gallery-card');
    if (!cards.length) return;
    autoSlideIdx = (autoSlideIdx + 1) % cards.length;
    const cardW = cards[0].offsetWidth + 12;
    track.scrollTo({ left: cardW * autoSlideIdx, behavior: 'smooth' });
  }, 4000);
  // Stop auto-slide on user interaction
  ['mousedown', 'touchstart', 'wheel'].forEach(evt => {
    track.addEventListener(evt, () => clearInterval(autoSlide), { once: true });
  });
}

/* --- Hero scarcity badge (dynamic) --- */
(async function() {
  try {
    const res = await fetch('https://oddparty-api-production.up.railway.app/api/scarcity');
    if (!res.ok) return;
    const data = await res.json();
    const dates = data.dates || {};
    const badge = document.getElementById('scarcity-badge');
    if (!badge) return;

    const dot = badge.querySelector('.scarcity-dot');
    const textEl = badge.querySelector('.scarcity-text');

    // 관리자 수동 설정 문구가 있으면 우선 사용
    if (data.custom_badge_text) {
      if (textEl) textEl.textContent = data.custom_badge_text;
      if (dot) dot.classList.add('urgent');
      badge.style.display = '';
      const sct = document.getElementById('sticky-cta-text');
      if (sct) sct.textContent = data.custom_sticky_text || data.custom_badge_text;
      return;
    }

    // 자동 단계별 텍스트
    const levels = Object.values(dates).map(d => d.level);
    const closedCount = levels.filter(l => l === '마감').length;
    const urgentCount = levels.filter(l => l === '마감임박').length;
    const fewCount = levels.filter(l => l === '잔여 소수').length;

    let text = '';
    let isUrgent = false;

    if (closedCount === 3) {
      text = '이번 주 파티 전일 마감!';
      isUrgent = true;
    } else if (closedCount > 0) {
      const closedDays = Object.entries(dates).filter(([,d]) => d.level === '마감').map(([k]) => k.replace('요일','')).join('·');
      text = closedDays + ' 마감! 서둘러 신청하세요';
      isUrgent = true;
    } else if (urgentCount > 0) {
      const urgentDays = Object.entries(dates).filter(([,d]) => d.level === '마감임박').map(([k]) => k.replace('요일','')).join('·');
      text = urgentDays + ' 마감 임박! 잔여석이 얼마 남지 않았어요';
      isUrgent = true;
    } else if (fewCount > 0) {
      text = '이번 주 파티 잔여석 소수!';
    } else {
      text = '이번 주 파티 신청 접수 중!';
    }

    if (textEl) textEl.textContent = text;
    if (dot && isUrgent) dot.classList.add('urgent');
    badge.style.display = '';

    // sticky-cta 텍스트도 동기화
    const stickyCtatext = document.getElementById('sticky-cta-text');
    if (stickyCtatext) {
      if (data.custom_sticky_text) {
        stickyCtatext.textContent = data.custom_sticky_text;
      } else {
        stickyCtatext.textContent = text;
      }
    }
  } catch { /* no backend */ }
})();

/* --- FAQ dynamic loading --- */
(async function loadFaq() {
  const container = document.getElementById('faq-list-container');
  if (!container) return;

  const FALLBACK_FAQ = [
    { question: '혼자 가도 괜찮을까요?', answer: '네, 전혀 문제 없습니다! ODD PARTY는 처음 만나는 분들이 어색함 없이 어울릴 수 있도록 다양한 아이스브레이킹 프로그램을 운영합니다. 혼자 오시는 분들이 오히려 더 다양한 만남을 경험하세요.' },
    { question: '참가 연령 제한이 있나요?', answer: '만 20세 이상 37세 이하를 대상으로 합니다. 보다 편안한 분위기를 위해 연령대를 적절히 조율하여 운영하고 있습니다.' },
    { question: '입금 후 취소/환불이 가능한가요?', answer: '파티 4일 전까지 전액 환불이 가능합니다. 3일 전~당일 취소는 환불이 불가합니다. 취소 문의는 카카오톡 채널로 연락해 주세요.' },
    { question: '어떤 프로그램이 진행되나요?', answer: '아이스브레이킹 게임, 테이블 토크, 자유 네트워킹 타임 등으로 구성되며, 매회 조금씩 새로운 프로그램이 추가됩니다. 음료와 간단한 스낵도 제공됩니다.' },
    { question: '신청 후 어떻게 확인하나요?', answer: '입금 완료 후 24시간 이내 문자 또는 카카오톡으로 확정 안내를 보내드립니다. 입금 계좌는 신청 완료 화면에서 확인하실 수 있습니다.' },
  ];

  let items = FALLBACK_FAQ;
  try {
    const res = await fetch('https://oddparty-api-production.up.railway.app/api/faq');
    if (res.ok) {
      const data = await res.json();
      if (data.faq && data.faq.length > 0) items = data.faq;
    }
  } catch { /* use fallback */ }

  container.innerHTML = items.map(f => `
    <li class="faq-item">
      <button class="faq-q" aria-expanded="false">
        <span class="faq-q-text">${f.question}</span>
        <span class="faq-icon" aria-hidden="true">+</span>
      </button>
      <div class="faq-a" role="region">
        <div class="faq-a-inner">${f.answer}</div>
      </div>
    </li>
  `).join('');

  // Re-bind accordion
  container.querySelectorAll('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      container.querySelectorAll('.faq-item.open').forEach(i => {
        i.classList.remove('open');
        i.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        item.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
})();

/* --- Dynamic site content from admin --- */
(async function loadSiteContent() {
  try {
    const res = await fetch('https://oddparty-api-production.up.railway.app/api/site-content');
    if (!res.ok) return;
    const data = await res.json();
    const content = data.content || {};
    Object.entries(content).forEach(([key, val]) => {
      if (!val || key === 'pricing' || key === 'scarcity-badge-text' || key === 'sticky-cta-text' || key === 'instagram-id') return;
      const el = document.getElementById(key);
      if (el) el.innerHTML = val.replace(/\n/g, '<br/>');
    });
  } catch { /* no backend */ }
})();

/* --- Scroll fade-up --- */
const fadeObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.12 });
document.querySelectorAll('.fade-up').forEach(el => fadeObserver.observe(el));

/* --- Share --- */
function sharePage() {
  if (navigator.share) {
    navigator.share({
      title: 'ODD PARTY — 낯선 사람들이 만나는 밤',
      text: '20-30대 소셜 파티, ODD PARTY 같이 가자! 🎉',
      url: location.origin + '/index.html'
    }).catch(() => {});
  } else {
    copyLink();
  }
}
function copyLink() {
  navigator.clipboard.writeText(location.href).then(() => {
    const btn = document.getElementById('copy-link-btn');
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> 복사됨!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
}
