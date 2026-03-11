# Development Guide

## Quick Start

```bash
# 1. 클론
git clone https://github.com/doublesilver/oddparty-site.git
cd oddparty-site

# 2. 의존성 설치
pip install pytest pytest-cov psycopg[binary]

# 3. 환경변수 설정
export ADMIN_PASSWORD=your_password
export JWT_SECRET=your_secret

# 4. 로컬 서버 실행
python3 serve_https.py
# → http://localhost:8443
```

---

## Project Structure

```
oddparty-site/
├── index.html              # 메인 랜딩 페이지 (고객용)
├── form.html               # 신청 폼 페이지 (고객용)
├── complete.html           # 신청 완료 페이지 (고객용)
├── admin.html              # 관리자 대시보드 (인라인 JS 3400+줄)
├── serve_https.py          # 백엔드 서버 전체 (단일 파일, 888 stmts)
├── assets/
│   ├── css/styles.css      # 전역 스타일시트
│   └── js/
│       ├── common.js       # 공통 유틸 (API_BASE, esc, fmtPrice)
│       ├── main.js         # 메인 페이지 로직
│       ├── form.js         # 신청 폼 로직
│       └── complete.js     # 완료 페이지 로직
├── tests/
│   └── test_backend.py     # 296 tests, 100% coverage
├── requirements.txt        # Python 의존성
├── Procfile                # Railway 배포 설정
└── vercel.json             # Vercel 배포 설정
```

---

## Deployment

### Frontend → Vercel (자동)

```
git push origin main → Vercel 자동 배포
URL: https://oddparty.vercel.app
```

### Backend → Railway (자동)

```
git push origin main → Railway 자동 배포
URL: https://oddparty-api-production.up.railway.app
```

### Environment Variables (Railway)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL 연결 문자열 |
| `ADMIN_PASSWORD` | 관리자 로그인 비밀번호 |
| `JWT_SECRET` | JWT 서명 키 |
| `PORT` | 서버 포트 (기본 8443) |

---

## Testing

```bash
# 전체 테스트 실행
python3 -m pytest tests/test_backend.py -q

# 커버리지 포함
python3 -m pytest tests/test_backend.py -q --cov=serve_https --cov-report=term-missing

# 특정 테스트만 실행
python3 -m pytest tests/test_backend.py -k "test_함수명" -v
```

**현재 기준**: 296 tests, 100% coverage (888/888 stmts)

---

## Architecture Overview

```
[Vercel CDN]                          [Railway]
 index.html  ──┐                    serve_https.py
 form.html   ──┼── REST API ──────▶  ├─ Auth (JWT/HMAC)
 complete.html ┤   (fetch)           ├─ 30+ Endpoints
 admin.html  ──┘                     ├─ Business Logic
                                     └─ SQLite / PostgreSQL
```

### API Base URL

`assets/js/common.js`의 `API_BASE` 변수가 백엔드 주소를 결정합니다:

```javascript
var API_BASE = 'https://oddparty-api-production.up.railway.app';
```

로컬 개발 시 `http://localhost:8443`으로 변경하면 로컬 백엔드를 사용합니다.

---

## Key Data Flow

### 가격/지점 데이터

```
admin.html savePricing()
  → POST /api/pricing (JWT 인증)
  → site_content["pricing"] 에 JSON 저장
  → GET /api/site-content (인증 불필요)
  → main.js / form.js / complete.js 에서 읽어서 렌더링
```

### 신청 접수

```
form.js submitForm()
  → POST /api/applications (할인코드 검증 포함)
  → sessionStorage에 결과 저장
  → complete.html로 리다이렉트
  → complete.js에서 sessionStorage 읽어서 렌더링
```

### 스카시티 (모집 상태)

```
admin.html: 정원 설정 + 수동 상태 오버라이드
  → GET /api/scarcity (자동 계산 + 수동 오버라이드 병합)
  → form.js: 날짜 버튼에 모집중/마감임박/마감 배지 표시
```

---

## Admin Panel Sections (7개)

| Section | ID | Description |
|---------|-----|-------------|
| 대시보드 | `sec-dashboard` | 신청자 목록, 검색, 상태 변경 |
| 정원 설정 | `sec-capacity` | 파티 날짜, 정원, 상태, 임계값 |
| 지점/가격 | `sec-branch` | 지점 CRUD, 가격, 2부 옵션 |
| 문구 수정 | `sec-content` | 폰 프리뷰 WYSIWYG 에디터 |
| FAQ | `sec-faq` | 질문/답변 CRUD |
| 할인코드 | `sec-discount` | 코드 생성, 관리 |
| 설정 | `sec-settings` | 계좌, SNS 연동, 비밀번호 |

---

## Common Tasks

### 새 API 엔드포인트 추가

1. `serve_https.py`에서 `do_GET` 또는 `do_POST`에 분기 추가
2. `tests/test_backend.py`에 테스트 작성
3. 커버리지 100% 유지 확인

### 프론트엔드 수정

- 메인 페이지 → `index.html` + `assets/js/main.js`
- 신청 폼 → `form.html` + `assets/js/form.js`
- 완료 페이지 → `complete.html` + `assets/js/complete.js`
- 관리자 → `admin.html` (인라인 JS)
- 공통 스타일 → `assets/css/styles.css`

### Claude Code로 개발 이어가기

```bash
cd oddparty-site
claude   # Claude Code CLI 실행
```

이전 대화 내용은 자동으로 메모리에 저장되어 있으므로 맥락을 이어서 작업할 수 있습니다.
