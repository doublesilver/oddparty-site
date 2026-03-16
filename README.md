# ODD PARTY — 소셜 파티 신청 플랫폼

> 20-30대를 위한 소셜 파티 신청 & 관리 풀스택 웹 애플리케이션

<p align="center">
  <img src="assets/images/logo-dark.png" alt="ODD PARTY Logo" height="48" />
</p>

<p align="center">
  <strong>Live</strong>:
  <a href="https://oddparty.vercel.app">oddparty.vercel.app</a>
</p>

---

## Overview

ODD PARTY는 소셜 파티 참가 신청부터 관리까지 한 곳에서 처리하는 풀스택 웹 서비스입니다.
프레임워크 없이 **Vanilla HTML/CSS/JS**와 **Python stdlib**만으로 구현하여, 외부 의존성을 최소화한 경량 아키텍처가 특징입니다.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Vercel (CDN)                       │
│  index.html ─ form.html ─ complete.html ─ admin.html    │
│  assets/css  ─  assets/js  ─  assets/images             │
└────────────────────────┬────────────────────────────────┘
                         │  REST API
                         ▼
┌─────────────────────────────────────────────────────────┐
│                   Railway (Backend)                      │
│                                                         │
│   serve_https.py (Python stdlib HTTP server)             │
│   ┌───────────┐  ┌──────────┐  ┌───────────────────┐   │
│   │ Auth/JWT  │  │ REST API │  │ Business Logic    │   │
│   │ (HMAC)    │  │ 30+ EP   │  │ (pricing/scarcity)│   │
│   └───────────┘  └──────────┘  └───────────────────┘   │
│                         │                               │
│              ┌──────────┴──────────┐                    │
│              ▼                     ▼                    │
│   ┌──────────────────┐  ┌──────────────────┐           │
│   │ SQLite (dev)     │  │ PostgreSQL (prod)│           │
│   └──────────────────┘  └──────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Note |
|-------|-----------|------|
| **Frontend** | HTML5, CSS3, Vanilla JS | 프레임워크 미사용, 순수 구현 |
| **Backend** | Python `http.server` | 단일 파일 (984 stmts), 외부 프레임워크 없음 |
| **Database** | SQLite / PostgreSQL | 환경변수(`DATABASE_URL`)로 자동 전환 |
| **Auth** | JWT (HMAC-SHA256) | Python `hmac` + `hashlib` 직접 구현 |
| **Hosting** | Vercel (FE) + Railway (BE) | 자동 배포 (Git push → deploy) |
| **Test** | pytest | **296 tests · 100% coverage** |

---

## Features

### Customer-Facing Pages

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  index.html  │────▶│  form.html   │────▶│complete.html │
│              │     │              │     │              │
│ • 히어로 섹션  │     │ • 신청 폼     │     │ • 결제 안내   │
│ • 지점별 가격  │     │ • 날짜 선택   │     │ • 계좌 복사   │
│ • 갤러리      │     │ • 할인코드    │     │ • SNS 공유   │
│ • FAQ        │     │ • 2부 옵션    │     │ • 인스타 링크  │
│ • 스카시티 배지│     │ • 실시간 가격  │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

| Feature | Description |
|---------|-------------|
| **지점별 가격 카드** | 클릭 시 해당 지점이 자동 선택된 신청 페이지로 이동 |
| **동적 가격 계산** | 성별 × 지점 × 2부 옵션 × 할인코드 실시간 반영 |
| **스카시티 배지** | 날짜별 모집중 / 마감임박 / 마감 자동 표시 |
| **할인코드** | 금액/비율 할인, 사용 제한, 실시간 검증 |
| **반응형 디자인** | 모바일 퍼스트, 다크 테마 기반 |

### Admin Dashboard (`admin.html`)

```
┌─────────────────────────────────────────────────┐
│  Admin Panel (7 Sections)                       │
│                                                 │
│  📊 대시보드      신청자 목록 · 검색 · 상태 관리    │
│  🗓️ 정원 설정     날짜 관리 · 정원 · 상태 임계값   │
│  🏢 지점/가격     지점 CRUD · 가격 · 2부 옵션     │
│  ✏️ 문구 수정     폰 프리뷰 WYSIWYG 에디터       │
│  ❓ FAQ          질문/답변 CRUD · 정렬           │
│  🎟️ 할인코드     생성 · 활성/비활성 · 사용현황    │
│  ⚙️ 설정         계좌 · SNS 연동 · 비밀번호      │
└─────────────────────────────────────────────────┘
```

| Feature | Description |
|---------|-------------|
| **신청자 관리** | 검색/필터, 상태 변경(미확인→입금확인→취소), 메모, CSV 내보내기 |
| **정원/상태 자동화** | 신청률 기반 자동 상태 계산 (임계값 커스터마이징 가능) |
| **비주얼 에디터** | 3개 페이지 폰 프리뷰에서 텍스트 직접 클릭 편집 |
| **섹션별 사용법** | 각 화면에 토글 가이드 내장 |
| **새로고침 복원** | URL hash 기반 현재 섹션 유지 |

---

## API Endpoints

30+ REST API 엔드포인트를 단일 파일로 구현:

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/applications` | — | 신청 접수 |
| `GET` | `/api/applications` | JWT | 신청 목록 조회 |
| `GET` | `/api/scarcity` | — | 날짜별 모집 상태 |
| `GET` | `/api/pricing` | — | 지점별 가격 정보 |
| `POST` | `/api/discount/validate` | — | 할인코드 검증 |
| `POST` | `/api/auth/login` | — | 관리자 로그인 |
| `POST` | `/api/capacity` | JWT | 정원 설정 |
| `POST` | `/api/pricing` | JWT | 가격 저장 |
| `CRUD` | `/api/admin/faq` | JWT | FAQ 관리 |
| `CRUD` | `/api/discount-codes` | JWT | 할인코드 관리 |
| ... | | | *외 20+ 엔드포인트* |

---

## Project Structure

```
oddparty-site/
├── index.html              # 메인 랜딩 페이지
├── form.html               # 신청 폼 페이지
├── complete.html           # 신청 완료 페이지
├── admin.html              # 관리자 대시보드
├── serve_https.py          # 백엔드 서버 (단일 파일, 984 stmts)
├── assets/
│   ├── css/styles.css      # 전역 스타일시트
│   ├── js/
│   │   ├── common.js       # 공통 유틸 (API_BASE, esc, fmtPrice)
│   │   ├── main.js         # 메인 페이지 로직
│   │   ├── form.js         # 신청 폼 로직 (가격 계산, 검증)
│   │   └── complete.js     # 완료 페이지 로직
│   └── images/             # 히어로, 갤러리, 로고 (WebP + PNG)
├── tests/
│   └── test_backend.py     # 296 tests, 100% coverage
├── requirements.txt        # psycopg[binary] (PostgreSQL 드라이버)
├── Procfile                # Railway 배포 설정
└── vercel.json             # Vercel 배포 설정
```

---

## Test & Coverage

```
$ python3 -m pytest tests/ -q --cov=serve_https

296 passed in 28s

Name             Stmts   Miss  Cover
----------------------------------------------
serve_https.py     984      0   100%
----------------------------------------------
TOTAL              984      0   100%
```

---

## Deployment

### Frontend (Vercel)

```bash
# Git push → 자동 배포
git push origin main
# Vercel이 정적 파일 자동 서빙 (cleanUrls 활성화)
```

### Backend (Railway)

```bash
# Git push → Railway 자동 배포
# Procfile: web: python serve_https.py
# 환경변수: DATABASE_URL, ADMIN_PASSWORD, JWT_SECRET
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | prod | PostgreSQL 연결 문자열 (없으면 SQLite) |
| `ADMIN_PASSWORD` | yes | 관리자 로그인 비밀번호 |
| `JWT_SECRET` | yes | JWT 서명 키 |
| `PORT` | no | 서버 포트 (기본 8443) |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **No framework (FE)** | 빠른 로딩, 번들 불필요, CDN 정적 서빙에 최적 |
| **No framework (BE)** | `http.server` stdlib만으로 30+ API 구현, 콜드스타트 최소화 |
| **Single-file backend** | 전체 비즈니스 로직을 한 파일에서 추적 가능, 배포 단순화 |
| **Dual DB support** | 개발(SQLite) → 운영(PostgreSQL) 무설정 전환 |
| **JWT 직접 구현** | 외부 라이브러리 의존 없이 `hmac` + `hashlib`로 구현 |
| **100% test coverage** | 단일 파일의 모든 분기를 검증, 리팩토링 안전망 |

---

## Local Development

```bash
# 1. Clone
git clone https://github.com/doublesilver/oddparty-site.git
cd oddparty-site

# 2. Backend
export ADMIN_PASSWORD=your_password
export JWT_SECRET=your_secret
python3 serve_https.py
# → http://localhost:8443

# 3. Frontend (별도 터미널)
# 브라우저에서 http://localhost:8443/index.html 접속
# 또는 Live Server 등으로 정적 파일 서빙

# 4. Test
pip install pytest pytest-cov psycopg[binary]
python3 -m pytest tests/ -q --cov=serve_https
```

---

## License

Private — All rights reserved.
