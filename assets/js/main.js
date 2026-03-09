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
