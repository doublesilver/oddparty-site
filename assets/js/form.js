/* =============================================
   FORM PAGE — depends on common.js (API_BASE, esc, fmtPrice, revealPage)
   ============================================= */

/* =============================================
   CALENDAR DATE PICKER
   ============================================= */
var calYear, calMonth;
var calActiveDates = null; // Set of 'YYYY-MM-DD', null = 자동(금/토/일 2주)
var calClosedDates = new Set(); // 마감된 날짜 Set
var calDateLabels = {}; // { 'YYYY-MM-DD': '만우절 교복특집' }
var calDateStatuses = {}; // { 'YYYY-MM-DD': '모집중' | '마감임박' | '마감' }
var calDateBranches = {}; // { 'YYYY-MM-DD': ['건대'] } — 날짜별 허용 지점 (없으면 전체)
var CAL_DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
var CAL_DAYNAME_MAP = {
  0: "일요일",
  1: "월요일",
  2: "화요일",
  3: "수요일",
  4: "목요일",
  5: "금요일",
  6: "토요일",
};

function toDateKey(date) {
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0")
  );
}

function isDateActive(date) {
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  if (date < today) return false;
  var key = toDateKey(date);
  if (calClosedDates.has(key)) return false;
  if (calActiveDates !== null) {
    return calActiveDates.has(key);
  }
  var twoWeeks = new Date(today);
  twoWeeks.setDate(today.getDate() + 14);
  var day = date.getDay();
  return (day === 0 || day === 5 || day === 6) && date <= twoWeeks;
}

function renderCalendar() {
  var months = [
    "1월",
    "2월",
    "3월",
    "4월",
    "5월",
    "6월",
    "7월",
    "8월",
    "9월",
    "10월",
    "11월",
    "12월",
  ];
  document.getElementById("cal-month-label").textContent =
    calYear + "년 " + months[calMonth];
  var grid = document.getElementById("cal-date-grid");
  grid.innerHTML = "";
  var firstDay = new Date(calYear, calMonth, 1).getDay();
  var lastDate = new Date(calYear, calMonth + 1, 0).getDate();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var selectedDate = document.getElementById("cal-selected-date").value;

  for (var i = 0; i < firstDay; i++) {
    var empty = document.createElement("div");
    empty.className = "cal-cell";
    grid.appendChild(empty);
  }

  for (var d = 1; d <= lastDate; d++) {
    var date = new Date(calYear, calMonth, d);
    var cell = document.createElement("button");
    cell.type = "button";
    var dow = date.getDay();
    var classes = ["cal-cell"];
    if (dow === 0) classes.push("sun");
    if (dow === 6) classes.push("sat");
    var isToday = date.getTime() === today.getTime();
    if (isToday) classes.push("today-cell");
    var dateStr = toDateKey(date);
    var dateStatus = calDateStatuses[dateStr] || null;
    var dateLabel = calDateLabels[dateStr] || null;
    if (isDateActive(date)) {
      classes.push("available");
      if (dateStatus === "마감임박") classes.push("cal-urgent");
      if (selectedDate === dateStr) classes.push("selected");
      cell.addEventListener(
        "click",
        (function (ds, dt, status, label) {
          return function () {
            document.getElementById("cal-selected-date").value = ds;
            var info = document.getElementById("cal-selected-info");
            var text =
              "선택: " +
              (dt.getMonth() + 1) +
              "월 " +
              dt.getDate() +
              "일(" +
              CAL_DAY_NAMES[dt.getDay()] +
              ")";
            if (label) text += " · " + esc(label);
            if (status && status !== "마감") {
              var statusColor = status === "마감임박" ? "#f43f5e" : "#22c55e";
              text +=
                ' <span style="color:' +
                statusColor +
                ';font-weight:700">[' +
                esc(status) +
                "]</span>";
            }
            info.innerHTML = text;
            info.style.display = "block";
            showError("err-date", false);
            onDateSelect(ds);
            renderCalendar();
          };
        })(dateStr, date, dateStatus, dateLabel),
      );
    } else {
      classes.push("inactive");
      cell.disabled = true;
    }
    cell.className = classes.join(" ");
    var numSpan = document.createElement("span");
    numSpan.textContent = d;
    cell.appendChild(numSpan);
    if (dateStatus && isDateActive(date)) {
      var statusSpan = document.createElement("span");
      statusSpan.className =
        "cal-status-dot" + (dateStatus === "마감임박" ? " urgent" : "");
      cell.appendChild(statusSpan);
    }
    if (isToday) {
      var todaySpan = document.createElement("span");
      todaySpan.className = "cal-today-label";
      todaySpan.textContent = "TODAY";
      cell.appendChild(todaySpan);
    }
    grid.appendChild(cell);
  }
}

(function initCalendar() {
  var now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
  document.getElementById("cal-prev").addEventListener("click", function () {
    var now = new Date();
    if (calYear === now.getFullYear() && calMonth === now.getMonth()) return;
    calMonth--;
    if (calMonth < 0) {
      calMonth = 11;
      calYear--;
    }
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", function () {
    var now = new Date();
    var maxY = now.getFullYear(),
      maxM = now.getMonth() + 1;
    if (maxM > 11) {
      maxM = 0;
      maxY++;
    }
    if (calYear === maxY && calMonth === maxM) return;
    calMonth++;
    if (calMonth > 11) {
      calMonth = 0;
      calYear++;
    }
    renderCalendar();
  });
})();

/* =============================================
   SCARCITY BADGES (dynamic from API)
   ============================================= */
async function loadScarcity() {
  try {
    const res = await fetch(API_BASE + "/api/scarcity");
    if (!res.ok) return;
    const data = await res.json();
    const dates = data.dates || {};

    /* 요일 키("일요일") → 날짜 키("2026-03-29") 매핑하여 상태 저장 */
    if (calActiveDates) {
      calActiveDates.forEach(function (dateKey) {
        var dt = new Date(dateKey + "T00:00:00");
        var dayName = CAL_DAYNAME_MAP[dt.getDay()];
        var info = dates[dayName];
        if (info && info.level) {
          calDateStatuses[dateKey] = info.level;
          if (info.level === "마감") {
            calClosedDates.add(dateKey);
          }
        }
      });
    } else {
      /* 기본 2주 모드: 금/토/일 날짜에 대해 scarcity 매핑 */
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      for (var i = 0; i <= 14; i++) {
        var dt = new Date(today);
        dt.setDate(today.getDate() + i);
        var day = dt.getDay();
        if (day === 0 || day === 5 || day === 6) {
          var dateKey = toDateKey(dt);
          var dayName = CAL_DAYNAME_MAP[day];
          var info = dates[dayName];
          if (info && info.level) {
            calDateStatuses[dateKey] = info.level;
            if (info.level === "마감") calClosedDates.add(dateKey);
          }
        }
      }
    }

    renderCalendar();
  } catch {
    /* no backend — badges stay empty */
  }
}

/* =============================================
   DYNAMIC SITE CONTENT + PRICING (single fetch)
   ============================================= */
async function loadSiteContentAndPricing() {
  try {
    const data = await fetchSiteContent();
    const content = data.content || {};

    /* Apply text content (sanitized) */
    Object.entries(content).forEach(([key, val]) => {
      if (!val || !key.startsWith("form-")) return;
      const el = document.getElementById(key);
      if (el) el.innerHTML = esc(val).replace(/\n/g, "<br/>");
    });

    /* Load pricing from same response */
    const raw = content.pricing;
    if (!raw) return;
    const pricing = typeof raw === "string" ? JSON.parse(raw) : raw;
    const newPrices = {};
    /* 글로벌 폴백값 */
    var globalP2Base = pricing.part2_base ? Number(pricing.part2_base) : 18000;
    var globalP2Disc = pricing.part2_discount
      ? Number(pricing.part2_discount)
      : 10;
    PART2_BASE = globalP2Base;
    PART2_DISCOUNT = globalP2Disc;
    Object.keys(pricing).forEach((key) => {
      if (key === "part2_base" || key === "part2_discount") return;
      const p = pricing[key];
      newPrices[key] = {
        male: Number(p.male),
        female: Number(p.female),
        note: p.note || "",
        part2_base: p.part2_base != null ? Number(p.part2_base) : globalP2Base,
        part2_discount:
          p.part2_discount != null ? Number(p.part2_discount) : globalP2Disc,
      };
    });
    if (Object.keys(newPrices).length > 0) PRICES = newPrices;

    renderBranchCards();
    updateBranchPriceLabels();
    updatePart2PrepayPrice();
    updatePrice();
  } catch {
    /* use defaults */
  }
}

/* =============================================
   ACCOUNT INFO (dynamic from API)
   ============================================= */
async function loadAccountInfo() {
  try {
    const res = await fetch(API_BASE + "/api/account");
    if (!res.ok) return;
    const data = await res.json();
    const { bank, account_number, holder } = data.account || data;
    const bankEl = document.getElementById("form-bank-name");
    const accountEl = document.getElementById("account-number");
    const holderEl = document.getElementById("form-account-holder");
    const noteBank = document.getElementById("form-submit-note-bank");
    const noteAccount = document.getElementById("form-submit-note-account");
    const noteHolder = document.getElementById("form-submit-note-holder");
    if (bank) {
      if (bankEl) bankEl.textContent = bank;
      if (noteBank) noteBank.textContent = bank;
    }
    if (account_number) {
      if (accountEl) accountEl.textContent = account_number;
      if (noteAccount) noteAccount.textContent = account_number;
    }
    if (holder) {
      if (holderEl) holderEl.textContent = "예금주: " + holder;
      if (noteHolder) noteHolder.textContent = holder;
    }
  } catch {
    /* no backend */
  }
}

/* =============================================
   PARTY DATES (from admin — replaces defaults when set)
   ============================================= */
async function loadPartyDates() {
  try {
    const res = await fetch(API_BASE + "/api/party-dates");
    if (!res.ok) return;
    const data = await res.json();
    const dates = data.dates || [];
    if (dates.length === 0) return;
    const dateSet = new Set();
    dates.forEach(function (d) {
      if (!d.date || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return;
      dateSet.add(d.date);
      if (d.label) calDateLabels[d.date] = d.label;
      if (d.branches && d.branches.length > 0)
        calDateBranches[d.date] = d.branches;
      if (d.level) {
        calDateStatuses[d.date] = d.level;
        if (d.level === "마감") calClosedDates.add(d.date);
      }
    });
    if (dateSet.size > 0) {
      calActiveDates = dateSet;
      renderCalendar();
    }
  } catch {
    /* no custom dates — keep defaults */
  }
}

/* =============================================
   DATE-BRANCH LINKING (날짜 선택 시 허용 지점 필터)
   ============================================= */
function onDateSelect(dateKey) {
  var allowed = calDateBranches[dateKey];
  var allInputs = document.querySelectorAll('input[name="branch"]');
  if (!allowed || allowed.length === 0) {
    /* 제한 없음 — 전체 지점 활성화 */
    allInputs.forEach(function (input) {
      input.disabled = false;
      var lbl = input.closest(".radio-card-label");
      if (lbl) lbl.classList.remove("disabled");
    });
    return;
  }
  /* 허용된 지점만 활성화 */
  var hadSelection = document.querySelector('input[name="branch"]:checked');
  allInputs.forEach(function (input) {
    var isAllowed = allowed.indexOf(input.value) >= 0;
    input.disabled = !isAllowed;
    var lbl = input.closest(".radio-card-label");
    if (lbl) lbl.classList.toggle("disabled", !isAllowed);
    if (!isAllowed && input.checked) {
      input.checked = false;
      if (lbl) lbl.classList.remove("selected");
    }
  });
  /* 허용 지점이 1개면 자동 선택 */
  if (allowed.length === 1) {
    var single = document.querySelector(
      'input[name="branch"][value="' + CSS.escape(allowed[0]) + '"]',
    );
    if (single && !single.disabled) {
      single.checked = true;
      single.closest(".radio-card-label")?.classList.add("selected");
      single.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

/* Load all dynamic data, then reveal page */
var _apiDone = Promise.all([
  loadSiteContentAndPricing(),
  loadAccountInfo(),
  loadPartyDates(),
]).then(function () {
  return loadScarcity();
});
var _timeout = new Promise(function (r) {
  setTimeout(r, 800);
});
Promise.race([_apiDone, _timeout]).then(revealPage);
_apiDone.finally(function () {
  revealPage();
  /* URL 파라미터로 지점 자동 선택 */
  var params = new URLSearchParams(location.search);
  var preselect = params.get("branch");
  if (preselect) {
    var input = document.querySelector(
      'input[name="branch"][value="' + CSS.escape(preselect) + '"]',
    );
    if (input) {
      input.checked = true;
      input.closest(".radio-card-label")?.classList.add("selected");
      input.dispatchEvent(new Event("change", { bubbles: true }));
      /* 지점 영역으로 스크롤 */
      var section = input.closest(".form-group");
      if (section)
        section.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
});

/* =============================================
   PRICE DATA (loaded from API, fallback to defaults)
   ============================================= */
let PRICES = Object.assign({}, DEFAULT_PRICES);
let PART2_BASE = DEFAULT_PART2_BASE;
let PART2_DISCOUNT = DEFAULT_PART2_DISCOUNT;

function getBranchNames() {
  return Object.keys(PRICES);
}

function renderBranchCards() {
  const grid = document.getElementById("branch-radio-grid");
  if (!grid) return;
  const names = getBranchNames();
  const count = names.length;
  grid.className = "radio-grid radio-grid-" + Math.min(count, 4);
  grid.innerHTML = "";
  names.forEach(function (branch) {
    var p = PRICES[branch];
    var label = document.createElement("label");
    label.className = "radio-card-label";

    var input = document.createElement("input");
    input.className = "radio-card-input";
    input.type = "radio";
    input.name = "branch";
    input.value = branch;
    label.appendChild(input);

    var nameSpan = document.createElement("span");
    nameSpan.className = "radio-card-name";
    nameSpan.textContent = "\uD83C\uDFE2 " + branch;
    label.appendChild(nameSpan);

    var subSpan = document.createElement("span");
    subSpan.className = "radio-card-sub";
    subSpan.id = "branch-price-" + branch;
    subSpan.textContent =
      "남 " + fmtPrice(p.male) + " / 여 " + fmtPrice(p.female);
    label.appendChild(subSpan);

    grid.appendChild(label);
  });
  initRadioCards("branch");
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
const preGender = urlParams.get("gender");
if (preGender) {
  const radio = document.getElementById("gender-" + preGender);
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

/* =============================================
   RADIO CARD ACTIVATION
   ============================================= */
function initRadioCards(groupName) {
  const inputs = document.querySelectorAll(`input[name="${groupName}"]`);
  inputs.forEach((input) => {
    const label = input.closest(".radio-card-label");
    if (!label) return;
    if (input.checked) label.classList.add("selected");
    input.addEventListener("change", () => {
      inputs.forEach((i) =>
        i.closest(".radio-card-label")?.classList.remove("selected"),
      );
      label.classList.add("selected");
      if (groupName === "gender" || groupName === "branch") {
        updateBranchPriceLabels();
        updatePrice();
      }
      if (groupName === "branch") onBranchChange();
      if (groupName === "part2pay") {
        updatePart2PrepayPrice();
        updatePrice();
      }
    });
  });
}
["gender", "branch", "date", "part2pay"].forEach(initRadioCards);

/* =============================================
   GET BRANCH-SPECIFIC PART2 VALUES
   ============================================= */
function getBranchPart2() {
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const bp = branch && PRICES[branch];
  return {
    base: bp && bp.part2_base != null ? bp.part2_base : PART2_BASE,
    discount:
      bp && bp.part2_discount != null ? bp.part2_discount : PART2_DISCOUNT,
  };
}

/* =============================================
   UPDATE BRANCH PRICE LABELS
   ============================================= */
function updateBranchPriceLabels() {
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  Object.keys(PRICES).forEach((branch) => {
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
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const label = e.target.closest(".radio-card-label:not(.disabled)");
  if (!label) return;
  e.preventDefault();
  label.querySelector("input")?.click();
});

/* =============================================
   DYNAMIC PRICE UPDATE
   ============================================= */
function updatePrice() {
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const joinPart2 = document.getElementById("joinPart2")?.checked;
  const part2pay = document.querySelector(
    'input[name="part2pay"]:checked',
  )?.value;
  const box = document.getElementById("price-box");
  const text = document.getElementById("price-box-text");

  if (!gender && !branch) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";

  if (gender && branch) {
    const price1 = PRICES[branch][gender];
    const branchEsc = esc(branch);
    const p2 = getBranchPart2();
    if (joinPart2) {
      if (part2pay === "prepay") {
        const total = Math.round((price1 + p2.base) * (1 - p2.discount / 100));
        text.innerHTML = `<strong>${branchEsc}점 1+2부 선결제</strong> · <span class="dynamic-price">${fmtPrice(total)}</span> <small style="color:var(--muted)">(${p2.discount}% 할인)</small>`;
      } else {
        text.innerHTML = `<strong>${branchEsc}점 1부</strong> · <span class="dynamic-price">${fmtPrice(price1)}</span> + 2부 현장 ${fmtPrice(p2.base)}`;
      }
    } else {
      text.innerHTML = `<strong>${branchEsc}점</strong> · <span class="dynamic-price">${fmtPrice(price1)}</span>`;
    }
  } else if (gender && !branch) {
    text.textContent = "지점을 선택하면 가격이 표시됩니다.";
  } else {
    text.textContent = "성별을 선택하면 가격이 표시됩니다.";
  }
}

/* =============================================
   2부 OPTIONS
   ============================================= */
function onBranchChange() {
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const part2Options = document.getElementById("part2Options");
  if (branch) {
    part2Options.style.display = "block";
  } else {
    part2Options.style.display = "none";
  }
  updatePart2PrepayPrice();
}

function updatePart2PrepayPrice() {
  const price1 = getPrice1();
  const priceEl = document.getElementById("part2PrepayPrice");
  if (!priceEl) return;
  if (price1 > 0) {
    const p2 = getBranchPart2();
    const prepayTotal = Math.round(
      (price1 + p2.base) * (1 - p2.discount / 100),
    );
    priceEl.textContent = fmtPrice(prepayTotal);
  } else {
    priceEl.textContent = "성별·지점 선택 후";
  }
}

document.getElementById("joinPart2").addEventListener("change", function () {
  const part2Methods = document.getElementById("part2Methods");
  part2Methods.style.display = this.checked ? "block" : "none";
  if (this.checked) {
    updatePart2PrepayPrice();
    initRadioCards("part2pay");
  }
  updatePrice();
});

/* =============================================
   COPY ACCOUNT
   ============================================= */
document
  .getElementById("copy-account-btn")
  .addEventListener("click", function () {
    const account = document.getElementById("account-number").textContent;
    navigator.clipboard
      .writeText(account)
      .then(() => {
        const btn = this;
        const orig = btn.innerHTML;
        btn.textContent = "✓ 복사됨";
        setTimeout(() => {
          btn.innerHTML = orig;
        }, 2000);
      })
      .catch(() => {});
  });

/* =============================================
   PHONE AUTO FORMAT
   ============================================= */
const phoneInput = document.getElementById("field-phone");
phoneInput.addEventListener("input", () => {
  let v = phoneInput.value.replace(/\D/g, "").slice(0, 11);
  if (v.length > 7) v = v.slice(0, 3) + "-" + v.slice(3, 7) + "-" + v.slice(7);
  else if (v.length > 3) v = v.slice(0, 3) + "-" + v.slice(3);
  phoneInput.value = v;
});

/* =============================================
   FORM VALIDATION & SUBMIT
   ============================================= */
function showError(id, show) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("show", show);
}

document.getElementById("party-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let valid = true;

  const name = document.getElementById("field-name").value.trim();
  const age = parseInt(document.getElementById("field-age").value);
  const phone = document.getElementById("field-phone").value.trim();
  const gender = document.querySelector('input[name="gender"]:checked')?.value;
  const branch = document.querySelector('input[name="branch"]:checked')?.value;
  const date = document.getElementById("cal-selected-date").value;
  const discount = document.getElementById("field-discount").value.trim();
  const instagram = document
    .getElementById("field-instagram")
    .value.trim()
    .replace(/^@/, "");
  const joinPart2 = document.getElementById("joinPart2").checked;
  const part2pay = joinPart2
    ? document.querySelector('input[name="part2pay"]:checked')?.value ||
      "prepay"
    : null;
  const agreeRules = document.getElementById("agree-rules").checked;
  const agreePrivacy = document.getElementById("agree-privacy").checked;

  showError("err-name", !name);
  if (!name) valid = false;

  showError("err-age", !age || age < 20 || age > 37);
  if (!age || age < 20 || age > 37) valid = false;

  showError("err-phone", !phone || phone.replace(/\D/g, "").length < 10);
  if (!phone || phone.replace(/\D/g, "").length < 10) valid = false;

  showError("err-gender", !gender);
  if (!gender) valid = false;

  showError("err-branch", !branch);
  if (!branch) valid = false;

  showError("err-date", !date);
  if (!date) valid = false;

  showError("err-terms", !agreeRules || !agreePrivacy);
  if (!agreeRules || !agreePrivacy) valid = false;

  if (!valid) {
    const firstErr = document.querySelector(".field-error.show");
    firstErr
      ?.closest(".field-group, .text-input-row")
      ?.querySelector("input")
      ?.focus();
    firstErr?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  /* Submit */
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.classList.add("loading");

  const price1 = getPrice1();
  let totalPrice = price1;
  let part2Amount = null;

  const p2 = getBranchPart2();
  if (joinPart2) {
    if (part2pay === "prepay") {
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
      const vRes = await fetch(API_BASE + "/api/discount/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: discount }),
      });
      if (vRes.ok) {
        const vData = await vRes.json();
        if (vData.valid) {
          if (vData.discount_type === "percent") {
            discountAmount = Math.round(
              (totalPrice * vData.discount_value) / 100,
            );
          } else {
            discountAmount = vData.discount_value || 0;
          }
          totalPrice = Math.max(0, totalPrice - discountAmount);
        } else {
          btn.disabled = false;
          btn.classList.remove("loading");
          showError("err-discount", true);
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
    instagram,
    discount,
    discountAmount,
    price: price1,
    joinPart2,
    part2pay: part2pay || null,
    totalPrice,
    part2Amount,
  };

  sessionStorage.setItem("odd_party_data", JSON.stringify(formData));

  try {
    await fetch(API_BASE + "/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
  } catch {
    /* No backend — continue gracefully */
  }

  window.location.href = "complete.html";
});

/* =============================================
   TERMS CHECKBOX LOGIC
   ============================================= */
document.getElementById("agree-all").addEventListener("change", function () {
  document.getElementById("agree-rules").checked = this.checked;
  document.getElementById("agree-privacy").checked = this.checked;
  showError("err-terms", false);
});
["agree-rules", "agree-privacy"].forEach(function (id) {
  document.getElementById(id).addEventListener("change", function () {
    document.getElementById("agree-all").checked =
      document.getElementById("agree-rules").checked &&
      document.getElementById("agree-privacy").checked;
    if (this.checked) showError("err-terms", false);
  });
});
document
  .getElementById("btn-view-rules")
  .addEventListener("click", function () {
    document.getElementById("terms-rules-content").classList.toggle("open");
  });
document
  .getElementById("btn-view-privacy")
  .addEventListener("click", function () {
    document.getElementById("terms-privacy-content").classList.toggle("open");
  });
