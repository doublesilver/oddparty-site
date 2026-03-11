/* =============================================
   COMMON UTILITIES — shared across all pages
   ============================================= */
var API_BASE = 'https://oddparty-api-production.up.railway.app';

/** HTML-escape user/API strings to prevent XSS */
function esc(s) {
  if (!s && s !== 0) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Format number as Korean won */
function fmtPrice(n) {
  return Number(n).toLocaleString('ko-KR') + '원';
}

/** Reveal all .dynamic-load elements (call once after API loads) */
function revealPage() {
  if (revealPage._done) return;
  revealPage._done = true;
  document.querySelectorAll('.dynamic-load').forEach(function(el) { el.classList.add('loaded'); });
}
