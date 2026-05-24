/* =============================================
   COMMON UTILITIES — shared across all pages
   ============================================= */
var API_BASE = "https://161-33-26-88.nip.io";

/** HTML-escape user/API strings to prevent XSS */
function esc(s) {
  if (!s && s !== 0) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format number as Korean won */
function fmtPrice(n) {
  return Number(n).toLocaleString("ko-KR") + "원";
}

/** Reveal all .dynamic-load elements (call once after API loads) */
function revealPage() {
  if (revealPage._done) return;
  revealPage._done = true;
  document.querySelectorAll(".dynamic-load").forEach(function (el) {
    el.classList.add("loaded");
  });
}

/* =============================================
   DEFAULT PRICES (single source of truth)
   ============================================= */
var DEFAULT_PRICES = {
  건대: { male: 33000, female: 23000, note: "포틀럭 포함" },
  영등포: { male: 39500, female: 29500, note: "안주 포함" },
};
var DEFAULT_PART2_BASE = 18000;
var DEFAULT_PART2_DISCOUNT = 10;

/* =============================================
   SITE-CONTENT CACHE (sessionStorage)
   ============================================= */
var _siteContentCache = null;

var _CACHE_TTL = 300000; /* 5분 */

function fetchSiteContent() {
  if (_siteContentCache) return Promise.resolve(_siteContentCache);
  var cached = sessionStorage.getItem("odd_site_content");
  if (cached) {
    try {
      var parsed = JSON.parse(cached);
      if (Date.now() - (parsed._ts || 0) < _CACHE_TTL) {
        _siteContentCache = parsed;
        return Promise.resolve(parsed);
      }
    } catch (e) {
      /* parse error — refetch */
    }
  }
  return fetch(API_BASE + "/api/site-content")
    .then(function (res) {
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    })
    .then(function (data) {
      data._ts = Date.now();
      _siteContentCache = data;
      try {
        sessionStorage.setItem("odd_site_content", JSON.stringify(data));
      } catch (e) {}
      return data;
    });
}

/* =============================================
   SHARE (shared across pages)
   ============================================= */
function sharePage(customText) {
  var title = "ODD PARTY — 낯선 사람들이 만나는 밤";
  var text = customText || "20-30대 소셜 파티, ODD PARTY 같이 가자!";
  var url = location.origin + "/index.html";
  if (navigator.share) {
    navigator
      .share({ title: title, text: text, url: url })
      .catch(function () {});
  } else {
    navigator.clipboard.writeText(url).then(function () {
      alert("링크가 복사되었습니다!");
    });
  }
}
