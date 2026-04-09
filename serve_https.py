#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import hmac
import http.server
import io
import json
import os
import re
import secrets
import sqlite3
import ssl
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None


ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
SQLITE_PATH = Path(os.getenv("SQLITE_PATH", DATA_DIR / "applications.db"))
PORT = int(os.getenv("PORT", "4443"))
CERT_FILE = ROOT_DIR / ".cert" / "cert.pem"
KEY_FILE = ROOT_DIR / ".cert" / "key.pem"
SEOUL_TZ = ZoneInfo("Asia/Seoul") if ZoneInfo else timezone.utc
IS_RAILWAY = any(
    os.getenv(key)
    for key in ("RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID")
)
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "oddparty2026")
ADMIN_TOKEN_FILE = DATA_DIR / ".admin_token"


def get_admin_token() -> str:
    """Return current admin token (file override > env var)."""
    if ADMIN_TOKEN_FILE.exists():
        stored = ADMIN_TOKEN_FILE.read_text().strip()
        if stored:
            return stored
    return ADMIN_TOKEN


def set_admin_token(new_token: str) -> None:
    """Persist new admin token to file."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ADMIN_TOKEN_FILE.write_text(new_token)
ALLOWED_ORIGINS = [
    "https://gagisiro-party-demo-site.vercel.app",
    "https://oddparty.vercel.app",
    "https://oddparty-api-production.up.railway.app",
]
ACCOUNT_INFO = {
    "bank": "농협",
    "number": "351-0948-4473-43",
    "holder": "이@봄",
}


class ValidationError(ValueError):
    pass


class ApplicationStore:
    def __init__(self) -> None:
        self.database_url = os.getenv("DATABASE_URL", "").strip()
        self.allow_sqlite_on_railway = os.getenv("ALLOW_SQLITE_ON_RAILWAY", "").strip() == "1"

        if IS_RAILWAY and not self.database_url and not self.allow_sqlite_on_railway:
            raise RuntimeError(
                "Railway deployment requires DATABASE_URL for persistent storage. "
                "Attach a Postgres service or set ALLOW_SQLITE_ON_RAILWAY=1 only for temporary testing."
            )

        self.kind = "postgres" if self.database_url else "sqlite"

    def initialize(self) -> None:
        if self.kind == "postgres":  # pragma: no cover
            self._init_postgres()
            return

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with self._sqlite_connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS applications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    name TEXT NOT NULL,
                    age INTEGER NOT NULL,
                    phone TEXT NOT NULL,
                    branch TEXT NOT NULL,
                    price_text TEXT NOT NULL,
                    price_amount INTEGER NOT NULL,
                    location_note TEXT NOT NULL,
                    party_date TEXT NOT NULL,
                    coupon TEXT,
                    status TEXT NOT NULL,
                    admin_note TEXT NOT NULL,
                    instagram TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS site_content (
                    content_key TEXT PRIMARY KEY,
                    content_value TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS capacity_settings (
                    day_key TEXT PRIMARY KEY,
                    capacity INTEGER NOT NULL DEFAULT 30,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS discount_codes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT NOT NULL UNIQUE,
                    discount_type TEXT NOT NULL DEFAULT 'fixed',
                    discount_value INTEGER NOT NULL DEFAULT 0,
                    max_uses INTEGER NOT NULL DEFAULT 0,
                    used_count INTEGER NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS faq (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    sort_order INTEGER DEFAULT 0,
                    is_active INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            # 기존 DB 마이그레이션: instagram 컬럼 추가
            try:
                connection.execute("ALTER TABLE applications ADD COLUMN instagram TEXT")
            except Exception:
                pass  # 이미 존재하면 무시

    def get_capacity_settings(self) -> dict:
        if self.kind == "postgres":  # pragma: no cover
            rows = self._query_all_postgres("SELECT day_key, capacity FROM capacity_settings")
            settings = {r["day_key"]: r["capacity"] for r in rows}
        else:
            with self._sqlite_connection() as conn:
                rows = conn.execute("SELECT day_key, capacity FROM capacity_settings").fetchall()
            settings = {r[0]: r[1] for r in rows}
        return settings

    def set_capacity(self, day_key: str, capacity: int) -> dict:
        if self.kind == "postgres":  # pragma: no cover
            with self._postgres_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO capacity_settings (day_key, capacity, updated_at)
                        VALUES (%s, %s, CURRENT_TIMESTAMP)
                        ON CONFLICT(day_key) DO UPDATE SET capacity=excluded.capacity, updated_at=excluded.updated_at
                        """,
                        (day_key, capacity),
                    )
        else:
            with self._sqlite_connection() as conn:
                conn.execute(
                    """
                    INSERT INTO capacity_settings (day_key, capacity, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(day_key) DO UPDATE SET capacity=excluded.capacity, updated_at=excluded.updated_at
                    """,
                    (day_key, capacity),
                )
        return self.get_capacity_settings()

    def get_date_counts(self) -> dict:
        """Count applications per date (excluding cancelled/refunded)."""
        if self.kind == "postgres":  # pragma: no cover
            rows = self._query_all_postgres(
                "SELECT party_date, COUNT(*) as cnt FROM applications WHERE status NOT IN ('취소','환불') GROUP BY party_date"
            )
            return {r["party_date"]: r["cnt"] for r in rows}
        else:
            with self._sqlite_connection() as conn:
                rows = conn.execute(
                    "SELECT party_date, COUNT(*) FROM applications WHERE status NOT IN ('취소','환불') GROUP BY party_date"
                ).fetchall()
            return {r[0]: r[1] for r in rows}

    def get_scarcity_info(self) -> dict:
        caps = self.get_capacity_settings()
        counts = self.get_date_counts()
        # 임계값 로드 (관리자 설정)
        try:
            threshold_urgent = int(self.get_site_content_value("scarcity_threshold_urgent") or 80)
        except (ValueError, TypeError):  # pragma: no cover
            threshold_urgent = 80
        try:
            threshold_closed = int(self.get_site_content_value("scarcity_threshold_closed") or 100)
        except (ValueError, TypeError):  # pragma: no cover
            threshold_closed = 100
        def _build_entry(key: str, day_name: str | None = None, label: str | None = None) -> dict:
            cap = caps.get(key, caps.get(day_name, 30) if day_name else 30)
            count = counts.get(key, 0)
            pct = (count / cap * 100) if cap > 0 else 0
            if cap == 0 or pct >= threshold_closed:
                level = "마감"
            elif pct >= threshold_urgent:
                level = "마감임박"
            else:
                level = "모집중"
            entry = {"capacity": cap, "count": count, "level": level}
            if day_name:
                entry["dayName"] = day_name
            if label:
                entry["label"] = label
            return entry

        # party_dates에서 날짜 목록을 가져와 날짜별 scarcity를 계산
        party_dates_raw = self.get_site_content_value("party_dates")
        party_dates = []
        if party_dates_raw:
            try:
                loaded_dates = json.loads(party_dates_raw)
                if isinstance(loaded_dates, list):
                    party_dates = loaded_dates
            except (json.JSONDecodeError, TypeError):  # pragma: no cover
                pass
        if party_dates:
            result = {}
            for pd in party_dates:
                date_key = str(pd.get("date", "")).strip()
                if not date_key:
                    continue
                day_name = str(pd.get("dayName", "")).strip() or None
                label = str(pd.get("label", "")).strip() or date_key
                result[date_key] = _build_entry(date_key, day_name=day_name, label=label)
            return result

        # party_dates가 없으면 기본 금/토/일 요일 키를 유지
        day_names = {"금요일", "토요일", "일요일"} | set(caps.keys())
        result = {}
        for day in day_names:
            result[day] = _build_entry(day)
        return result

    def create_application(self, payload: dict) -> dict:
        normalized = self._normalize_payload(payload)

        if self.kind == "postgres":  # pragma: no cover
            application_id = self._insert_postgres(normalized)
            return self.get_application(application_id)

        with self._sqlite_connection() as connection:
            cursor = connection.execute(
                """
                INSERT INTO applications (
                    name, age, phone, branch, price_text, price_amount,
                    location_note, party_date, coupon, status, admin_note, instagram
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    normalized["name"],
                    normalized["age"],
                    normalized["phone"],
                    normalized["branch"],
                    normalized["price_text"],
                    normalized["price_amount"],
                    normalized["location_note"],
                    normalized["party_date"],
                    normalized["coupon"],
                    normalized["status"],
                    normalized["admin_note"],
                    normalized["instagram"],
                ),
            )
            application_id = cursor.lastrowid

        return self.get_application(application_id)

    def get_application(self, application_id: int) -> dict | None:
        if self.kind == "postgres":  # pragma: no cover
            row = self._query_one_postgres(
                "SELECT * FROM applications WHERE id = %s",
                (application_id,),
            )
        else:
            with self._sqlite_connection() as connection:
                row = connection.execute(
                    "SELECT * FROM applications WHERE id = ?",
                    (application_id,),
                ).fetchone()

        if not row:
            return None

        return self._serialize_row(row)

    def list_applications(self) -> dict:
        if self.kind == "postgres":  # pragma: no cover
            rows = self._query_all_postgres("SELECT * FROM applications ORDER BY id DESC")
        else:
            with self._sqlite_connection() as connection:
                rows = connection.execute(
                    "SELECT * FROM applications ORDER BY id DESC"
                ).fetchall()

        applications = [self._serialize_row(row) for row in rows]
        return {
            "applications": applications,
            "stats": self._build_stats(applications),
            "storage": self.kind,
            "account": ACCOUNT_INFO,
        }

    def update_application(self, application_id: int, updates: dict) -> dict | None:
        allowed_fields = {"status", "admin_note", "party_date"}
        filtered = {k: str(v).strip() for k, v in updates.items() if k in allowed_fields and v is not None}
        if not filtered:
            return self.get_application(application_id)

        existing = self.get_application(application_id)
        if not existing:
            return None

        if self.kind == "postgres":  # pragma: no cover
            set_clause = ", ".join(f"{k} = %s" for k in filtered)
            self._query_one_postgres(
                f"UPDATE applications SET {set_clause} WHERE id = %s",
                (*filtered.values(), application_id),
            )
        else:
            set_clause = ", ".join(f"{k} = ?" for k in filtered)
            with self._sqlite_connection() as connection:
                connection.execute(
                    f"UPDATE applications SET {set_clause} WHERE id = ?",
                    (*filtered.values(), application_id),
                )

        return self.get_application(application_id)

    def export_applications_csv(self) -> str:
        data = self.list_applications()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["신청일시", "이름", "나이", "전화번호", "성별", "지점", "파티날짜", "쿠폰", "상태", "관리자메모", "금액"])
        for app in data["applications"]:
            price_text = app.get("priceText", "")
            gender = "여" if "여" in price_text else ("남" if "남" in price_text else "")
            writer.writerow([
                app["createdAt"], app["name"], app["age"],
                app["phone"], gender, app["branch"], app["partyDate"],
                app["coupon"] or "", app["status"], app["adminNote"], app["priceAmount"],
            ])
        return output.getvalue()

    def export_backup_json(self) -> dict:
        data = self.list_applications()
        content = self.get_site_content()
        return {
            "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "storage": self.kind,
            "applications": data["applications"],
            "stats": data["stats"],
            "siteContent": content,
        }

    def get_site_content(self) -> dict:
        if self.kind == "postgres":  # pragma: no cover
            rows = self._query_all_postgres(
                "SELECT content_key, content_value FROM site_content ORDER BY content_key ASC"
            )
            return {row["content_key"]: row["content_value"] for row in rows}

        with self._sqlite_connection() as connection:
            rows = connection.execute(
                "SELECT content_key, content_value FROM site_content ORDER BY content_key ASC"
            ).fetchall()
        return {row["content_key"]: row["content_value"] for row in rows}

    def get_site_content_value(self, key: str) -> str | None:
        content = self.get_site_content()
        val = content.get(key, "").strip()
        return val if val else None

    def upsert_site_content(self, content: dict) -> dict:
        normalized = self._normalize_site_content(content)
        if not normalized:
            return self.get_site_content()

        if self.kind == "postgres":  # pragma: no cover
            with self._postgres_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.executemany(
                        """
                        INSERT INTO site_content (content_key, content_value, updated_at)
                        VALUES (%s, %s, CURRENT_TIMESTAMP)
                        ON CONFLICT (content_key)
                        DO UPDATE SET
                            content_value = EXCLUDED.content_value,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        list(normalized.items()),
                    )
            return self.get_site_content()

        with self._sqlite_connection() as connection:
            connection.executemany(
                """
                INSERT INTO site_content (content_key, content_value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(content_key) DO UPDATE SET
                    content_value = excluded.content_value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                list(normalized.items()),
            )

        return self.get_site_content()

    def get_discount_codes(self) -> list[dict]:
        if self.kind == "postgres":  # pragma: no cover
            rows = self._query_all_postgres("SELECT * FROM discount_codes ORDER BY id DESC")
        else:
            with self._sqlite_connection() as conn:
                rows = conn.execute("SELECT * FROM discount_codes ORDER BY id DESC").fetchall()
        return [self._serialize_discount(row) for row in rows]

    def create_discount_code(self, code: str, discount_type: str, discount_value: int, max_uses: int) -> dict:
        if self.kind == "postgres":  # pragma: no cover
            row = self._query_one_postgres(
                """
                INSERT INTO discount_codes (code, discount_type, discount_value, max_uses)
                VALUES (%s, %s, %s, %s)
                RETURNING *
                """,
                (code, discount_type, discount_value, max_uses),
            )
            return self._serialize_discount(row)
        else:
            with self._sqlite_connection() as conn:
                cursor = conn.execute(
                    """
                    INSERT INTO discount_codes (code, discount_type, discount_value, max_uses)
                    VALUES (?, ?, ?, ?)
                    """,
                    (code, discount_type, discount_value, max_uses),
                )
                new_id = cursor.lastrowid
            with self._sqlite_connection() as conn:
                row = conn.execute("SELECT * FROM discount_codes WHERE id = ?", (new_id,)).fetchone()
            return self._serialize_discount(row)

    def _serialize_discount(self, row) -> dict:
        data = dict(row)
        if "created_at" in data:
            data["created_at"] = self._to_iso8601(data["created_at"])
        return data

    def validate_discount_code(self, code: str) -> dict | None:
        if self.kind == "postgres":  # pragma: no cover
            row = self._query_one_postgres(
                "SELECT * FROM discount_codes WHERE code = %s AND is_active = 1",
                (code,),
            )
        else:
            with self._sqlite_connection() as conn:
                row = conn.execute(
                    "SELECT * FROM discount_codes WHERE code = ? AND is_active = 1",
                    (code,),
                ).fetchone()
        if not row:
            return None
        data = self._serialize_discount(row)
        if data["max_uses"] > 0 and data["used_count"] >= data["max_uses"]:
            return None
        return data

    def update_discount_code(self, code_id: int, updates: dict) -> dict | None:
        """Update a discount code's fields (discount_type, discount_value, max_uses, is_active)."""
        allowed = {"discount_type", "discount_value", "max_uses", "is_active"}
        filtered = {k: v for k, v in updates.items() if k in allowed}
        if not filtered:
            return None
        if self.kind == "postgres":  # pragma: no cover
            set_clause = ", ".join(f"{k} = %s" for k in filtered)
            values = list(filtered.values()) + [code_id]
            row = self._query_one_postgres(
                f"UPDATE discount_codes SET {set_clause} WHERE id = %s RETURNING *",
                tuple(values),
            )
            return self._serialize_discount(row) if row else None
        else:
            set_clause = ", ".join(f"{k} = ?" for k in filtered)
            values = list(filtered.values()) + [code_id]
            with self._sqlite_connection() as conn:
                conn.execute(f"UPDATE discount_codes SET {set_clause} WHERE id = ?", values)
                row = conn.execute("SELECT * FROM discount_codes WHERE id = ?", (code_id,)).fetchone()
            return self._serialize_discount(row) if row else None

    def delete_discount_code(self, code_id: int) -> bool:
        if self.kind == "postgres":  # pragma: no cover
            with self._postgres_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM discount_codes WHERE id = %s", (code_id,))
                    return cur.rowcount > 0
        else:
            with self._sqlite_connection() as conn:
                cur = conn.execute("DELETE FROM discount_codes WHERE id = ?", (code_id,))
                return cur.rowcount > 0

    def increment_discount_usage(self, code: str) -> None:
        if self.kind == "postgres":  # pragma: no cover
            self._query_one_postgres(
                "UPDATE discount_codes SET used_count = used_count + 1 WHERE code = %s",
                (code,),
            )
        else:
            with self._sqlite_connection() as conn:
                conn.execute(
                    "UPDATE discount_codes SET used_count = used_count + 1 WHERE code = ?",
                    (code,),
                )

    def get_faq_items(self, active_only: bool = True) -> list[dict]:
        if active_only:
            query_pg = "SELECT * FROM faq WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
            query_sq = "SELECT * FROM faq WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
        else:
            query_pg = "SELECT * FROM faq ORDER BY sort_order ASC, id ASC"
            query_sq = "SELECT * FROM faq ORDER BY sort_order ASC, id ASC"

        if self.kind == "postgres":  # pragma: no cover
            rows = self._query_all_postgres(query_pg)
        else:
            with self._sqlite_connection() as conn:
                rows = conn.execute(query_sq).fetchall()
        return [self._serialize_faq(row) for row in rows]

    def create_faq_item(self, question: str, answer: str, sort_order: int) -> dict:
        if self.kind == "postgres":  # pragma: no cover
            row = self._query_one_postgres(
                """
                INSERT INTO faq (question, answer, sort_order)
                VALUES (%s, %s, %s)
                RETURNING *
                """,
                (question, answer, sort_order),
            )
            return self._serialize_faq(row)
        else:
            with self._sqlite_connection() as conn:
                cursor = conn.execute(
                    "INSERT INTO faq (question, answer, sort_order) VALUES (?, ?, ?)",
                    (question, answer, sort_order),
                )
                new_id = cursor.lastrowid
            with self._sqlite_connection() as conn:
                row = conn.execute("SELECT * FROM faq WHERE id = ?", (new_id,)).fetchone()
            return self._serialize_faq(row)

    def update_faq_item(self, faq_id: int, question: str, answer: str, sort_order: int, is_active: int) -> dict | None:
        if self.kind == "postgres":  # pragma: no cover
            row = self._query_one_postgres(
                """
                UPDATE faq SET question = %s, answer = %s, sort_order = %s, is_active = %s
                WHERE id = %s
                RETURNING *
                """,
                (question, answer, sort_order, is_active, faq_id),
            )
            if not row:
                return None
            return self._serialize_faq(row)
        else:
            with self._sqlite_connection() as conn:
                conn.execute(
                    "UPDATE faq SET question = ?, answer = ?, sort_order = ?, is_active = ? WHERE id = ?",
                    (question, answer, sort_order, is_active, faq_id),
                )
            with self._sqlite_connection() as conn:
                row = conn.execute("SELECT * FROM faq WHERE id = ?", (faq_id,)).fetchone()
            if not row:
                return None
            return self._serialize_faq(row)

    def delete_faq_item(self, faq_id: int) -> None:
        if self.kind == "postgres":  # pragma: no cover
            with self._postgres_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM faq WHERE id = %s", (faq_id,))
        else:
            with self._sqlite_connection() as conn:
                conn.execute("DELETE FROM faq WHERE id = ?", (faq_id,))

    def delete_application(self, application_id: int) -> bool:
        existing = self.get_application(application_id)
        if not existing:
            return False
        if self.kind == "postgres":  # pragma: no cover
            with self._postgres_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM applications WHERE id = %s", (application_id,))
        else:
            with self._sqlite_connection() as conn:
                conn.execute("DELETE FROM applications WHERE id = ?", (application_id,))
        return True

    def bulk_delete_applications(self, ids: list[int]) -> int:
        """Delete multiple applications in a single query. Returns count deleted."""
        if not ids:
            return 0
        if self.kind == "postgres":  # pragma: no cover
            placeholders = ",".join(["%s"] * len(ids))
            with self._postgres_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(f"DELETE FROM applications WHERE id IN ({placeholders})", tuple(ids))
                    return cur.rowcount
        else:
            placeholders = ",".join(["?"] * len(ids))
            with self._sqlite_connection() as conn:
                cur = conn.execute(f"DELETE FROM applications WHERE id IN ({placeholders})", ids)
                return cur.rowcount

    def get_account_info(self) -> dict:
        stored = self.get_site_content_value("account")
        if stored:
            try:
                return json.loads(stored)
            except (json.JSONDecodeError, TypeError):
                pass
        return {"bank": "농협은행", "account_number": "351-0948-4473-43", "holder": "이@봄"}

    def set_account_info(self, account: dict) -> dict:
        self.upsert_site_content({"account": json.dumps(account, ensure_ascii=False)})
        return self.get_account_info()

    def _serialize_faq(self, row) -> dict:
        data = dict(row)
        if "created_at" in data:
            data["created_at"] = self._to_iso8601(data["created_at"])
        return data

    def _normalize_payload(self, payload: dict) -> dict:
        name = self._require_text(payload.get("name"), "이름", 40)
        phone = re.sub(r"[^0-9]", "", str(payload.get("phone", "")))
        if len(phone) < 11 or len(phone) > 14:
            raise ValidationError("전화번호는 하이픈 없이 11자리 이상 입력해 주세요.")

        try:
            age = int(str(payload.get("age", "")).strip())
        except ValueError as exc:
            raise ValidationError("나이는 숫자로 입력해 주세요.") from exc

        if age < 20 or age > 37:
            raise ValidationError("만 20~37세만 신청 가능합니다.")

        # form.js sends: branch, gender, date, discount, price
        branch = self._require_text(payload.get("branch"), "지점", 40)
        gender = self._require_text(payload.get("gender"), "성별", 10)

        # Load pricing from admin settings, fallback to defaults
        DEFAULT_PRICES = {
            "건대": {"male": 33000, "female": 23000, "note": "포틀럭 포함"},
            "영등포": {"male": 39500, "female": 29500, "note": "안주 포함"},
        }
        stored_pricing = STORE.get_site_content_value("pricing")
        if stored_pricing:
            try:
                PRICES = json.loads(stored_pricing)
            except (json.JSONDecodeError, TypeError):
                PRICES = DEFAULT_PRICES
        else:
            PRICES = DEFAULT_PRICES
        branch_prices = PRICES.get(branch)
        if not branch_prices:
            raise ValidationError("지점 정보를 다시 선택해 주세요.")
        base_price = branch_prices.get(gender, 0)
        gender_label = "남" if gender == "male" else "여"
        location_note = branch

        # 2부 참여 여부 처리
        part2pay = str(payload.get("part2pay") or "").strip() or None
        # 지점별 2부 가격 (없으면 글로벌 → 기본값 순으로 폴백)
        PART2_BASE = int(branch_prices.get("part2_base", PRICES.get("part2_base", 18000)))
        PART2_DISCOUNT = int(branch_prices.get("part2_discount", PRICES.get("part2_discount", 10)))

        if part2pay == "prepay":
            price_amount = round((base_price + PART2_BASE) * (1 - PART2_DISCOUNT / 100))
            price_text = f"{gender_label} {price_amount:,}원 (1부+2부)"
        else:
            price_amount = base_price
            price_text = f"{gender_label} {price_amount:,}원"

        party_date = self._require_text(payload.get("date") or payload.get("partyDate"), "참여 날짜", 80)
        instagram = str(payload.get("instagram") or "").strip().lstrip("@")[:50] or None
        coupon = str(payload.get("discount") or payload.get("coupon") or "").strip() or None
        if coupon and len(coupon) > 40:
            raise ValidationError("할인코드는 40자 이내로 입력해 주세요.")

        # Apply discount if coupon is valid
        discount_applied = 0
        if coupon:
            discount_info = STORE.validate_discount_code(coupon)
            if discount_info:
                if discount_info["discount_type"] == "percent":
                    discount_applied = round(price_amount * discount_info["discount_value"] / 100)
                else:
                    discount_applied = discount_info["discount_value"]
                price_amount = max(0, price_amount - discount_applied)
                suffix = " (1부+2부, 할인 적용)" if part2pay == "prepay" else " (할인 적용)"
                price_text = f"{gender_label} {price_amount:,}원{suffix}"

        is_closed_branch = (price_amount == 0 and discount_applied == 0) or location_note == "마감"
        status = "보류" if is_closed_branch else "입금대기"
        notes = []
        if part2pay == "prepay":
            notes.append("2부 사전결제 포함")
        elif part2pay == "onsite":
            notes.append("2부 현장결제 예정")
        if discount_applied > 0:
            notes.append(f"할인코드 {coupon} 적용 (-{discount_applied:,}원)")
        elif coupon and discount_applied == 0:
            notes.append("할인코드 확인 필요")
        admin_note = (
            "현재 마감되어 확인필요"
            if is_closed_branch
            else (", ".join(notes) if notes else "신규 신청 접수")
        )

        return {
            "name": name,
            "age": age,
            "phone": phone,
            "branch": branch,
            "price_text": price_text,
            "price_amount": price_amount,
            "location_note": location_note,
            "party_date": party_date,
            "instagram": instagram,
            "coupon": coupon,
            "status": status,
            "admin_note": admin_note,
        }

    @staticmethod
    def _normalize_site_content(content: dict) -> dict:
        if not isinstance(content, dict):
            raise ValidationError("콘텐츠 저장 형식이 올바르지 않습니다.")

        normalized = {}
        for key, value in content.items():
            content_key = str(key or "").strip()
            if not content_key or len(content_key) > 120:
                raise ValidationError("콘텐츠 키 형식이 올바르지 않습니다.")

            content_value = str(value or "")
            if len(content_value) > 5000:
                raise ValidationError(f"{content_key} 값이 너무 깁니다.")

            normalized[content_key] = content_value

        return normalized

    def _serialize_row(self, row: sqlite3.Row | dict) -> dict:
        data = dict(row)
        coupon = data.get("coupon") or ""
        created_at = self._to_iso8601(data.get("created_at"))
        return {
            "id": data["id"],
            "createdAt": created_at,
            "name": data["name"],
            "age": data["age"],
            "phone": data["phone"],
            "branch": data["branch"],
            "priceText": data["price_text"],
            "priceAmount": data["price_amount"],
            "locationNote": data["location_note"],
            "partyDate": data["party_date"],
            "instagram": data.get("instagram") or "",
            "coupon": coupon,
            "status": data["status"],
            "adminNote": data["admin_note"],
        }

    def _build_stats(self, applications: list[dict]) -> dict:
        today = datetime.now(SEOUL_TZ).date()
        today_count = 0
        coupon_count = 0

        for application in applications:
            created_at = self._parse_iso_datetime(application["createdAt"])
            if created_at.astimezone(SEOUL_TZ).date() == today:
                today_count += 1
            if application["coupon"]:
                coupon_count += 1

        return {
            "todayCount": today_count,
            "totalCount": len(applications),
            "couponCount": coupon_count,
        }

    def _sqlite_connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(SQLITE_PATH, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_postgres(self) -> None:  # pragma: no cover
        with self._postgres_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS applications (
                        id SERIAL PRIMARY KEY,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        name TEXT NOT NULL,
                        age INTEGER NOT NULL,
                        phone TEXT NOT NULL,
                        branch TEXT NOT NULL,
                        price_text TEXT NOT NULL,
                        price_amount INTEGER NOT NULL,
                        location_note TEXT NOT NULL,
                        party_date TEXT NOT NULL,
                        coupon TEXT,
                        status TEXT NOT NULL,
                        admin_note TEXT NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS site_content (
                        content_key TEXT PRIMARY KEY,
                        content_value TEXT NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS capacity_settings (
                        day_key TEXT PRIMARY KEY,
                        capacity INTEGER NOT NULL DEFAULT 30,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS discount_codes (
                        id SERIAL PRIMARY KEY,
                        code TEXT NOT NULL UNIQUE,
                        discount_type TEXT NOT NULL DEFAULT 'fixed',
                        discount_value INTEGER NOT NULL DEFAULT 0,
                        max_uses INTEGER NOT NULL DEFAULT 0,
                        used_count INTEGER NOT NULL DEFAULT 0,
                        is_active INTEGER NOT NULL DEFAULT 1,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS faq (
                        id SERIAL PRIMARY KEY,
                        question TEXT NOT NULL,
                        answer TEXT NOT NULL,
                        sort_order INTEGER DEFAULT 0,
                        is_active INTEGER DEFAULT 1,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )

    def _insert_postgres(self, normalized: dict) -> int:  # pragma: no cover
        row = self._query_one_postgres(
            """
            INSERT INTO applications (
                name, age, phone, branch, price_text, price_amount,
                location_note, party_date, coupon, status, admin_note
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                normalized["name"],
                normalized["age"],
                normalized["phone"],
                normalized["branch"],
                normalized["price_text"],
                normalized["price_amount"],
                normalized["location_note"],
                normalized["party_date"],
                normalized["coupon"],
                normalized["status"],
                normalized["admin_note"],
            ),
        )
        return row["id"]

    def _query_one_postgres(self, query: str, params: tuple = ()) -> dict | None:  # pragma: no cover
        from psycopg.rows import dict_row

        with self._postgres_connection(row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(query, params)
                return cursor.fetchone()

    def _query_all_postgres(self, query: str, params: tuple = ()) -> list[dict]:  # pragma: no cover
        from psycopg.rows import dict_row

        with self._postgres_connection(row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(query, params)
                return cursor.fetchall()

    def _postgres_connection(self, **kwargs):  # pragma: no cover
        try:
            import psycopg
        except ImportError as exc:
            raise RuntimeError(
                "DATABASE_URL is set but psycopg is not installed. Install requirements.txt first."
            ) from exc

        return psycopg.connect(self.database_url, autocommit=True, **kwargs)

    @staticmethod
    def _require_text(raw_value: object, field_name: str, max_length: int) -> str:
        value = str(raw_value or "").strip()
        if not value:
            raise ValidationError(f"{field_name}을(를) 입력해 주세요.")
        if len(value) > max_length:
            raise ValidationError(f"{field_name}은(는) {max_length}자 이내로 입력해 주세요.")
        return value

    @staticmethod
    def _to_iso8601(raw_value: object) -> str:
        if isinstance(raw_value, datetime):
            parsed = raw_value
        else:
            text = str(raw_value or "").strip()
            if not text:
                parsed = datetime.now(timezone.utc)
            else:
                try:
                    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
                except ValueError:  # pragma: no cover — Python <3.11 fallback
                    parsed = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")

        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)

        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _parse_iso_datetime(value: str) -> datetime:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed


STORE = ApplicationStore()
STORE.initialize()


class PartyRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs) -> None:
        super().__init__(*args, directory=directory or str(ROOT_DIR), **kwargs)

    def _is_admin_authenticated(self) -> bool:
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return False
        token = auth_header[7:].strip()
        if not token:
            return False
        return hmac.compare_digest(token, get_admin_token())

    def _require_admin(self) -> bool:
        if self._is_admin_authenticated():
            return True
        self._write_json(401, {"error": "관리자 인증이 필요합니다."})
        return False

    def _is_origin_allowed(self, origin: str) -> bool:
        if not origin:
            return True
        if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
            return True
        return origin in ALLOWED_ORIGINS

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path in {"/admin.html", "/admin/"}:
            self.send_response(302)
            self.send_header("Location", "/admin")
            self.end_headers()
            return

        if parsed.path == "/admin":
            self.path = "/admin.html"
            super().do_GET()
            return

        if parsed.path == "/api/health":
            self._write_json(
                200,
                {"ok": True, "storage": STORE.kind, "account": ACCOUNT_INFO},
            )
            return

        if parsed.path == "/api/auth/check":
            if not self._require_admin():
                return
            self._write_json(200, {"ok": True})
            return

        if parsed.path == "/api/site-content":
            self._write_json(200, {"content": STORE.get_site_content()})
            return

        if parsed.path == "/api/account":
            self._write_json(200, {"account": STORE.get_account_info()})
            return

        if parsed.path == "/api/admin/account":
            if not self._require_admin():
                return
            self._write_json(200, {"account": STORE.get_account_info()})
            return

        if parsed.path == "/api/pricing":
            if not self._require_admin():
                return
            pricing = STORE.get_site_content_value("pricing")
            import json as _json
            pricing_data = _json.loads(pricing) if pricing else {
                "건대": {"male": 33000, "female": 23000, "note": "포틀럭 포함"},
                "영등포": {"male": 39500, "female": 29500, "note": "안주 포함"},
                "part2_base": 18000,
                "part2_discount": 10,
            }
            self._write_json(200, {"pricing": pricing_data})
            return

        if parsed.path == "/api/scarcity":
            result = {"dates": STORE.get_scarcity_info()}
            # Apply manual overrides if set
            override_raw = STORE.get_site_content_value("scarcity_override")
            if override_raw:
                try:
                    overrides = json.loads(override_raw) if isinstance(override_raw, str) else override_raw
                    for key, level in overrides.items():
                        if not level:
                            continue
                        if key in result["dates"]:
                            result["dates"][key]["level"] = level
                            continue
                        for info in result["dates"].values():
                            if info.get("dayName") == key:
                                info["level"] = level
                except Exception:
                    pass
            custom_text = STORE.get_site_content_value("scarcity-badge-text")
            if custom_text:
                result["custom_badge_text"] = custom_text
            custom_sticky = STORE.get_site_content_value("sticky-cta-text")
            if custom_sticky:
                result["custom_sticky_text"] = custom_sticky
            ig_id = STORE.get_site_content_value("instagram-id")
            if ig_id:
                result["instagram_id"] = ig_id
            self._write_json(200, result)
            return

        if parsed.path == "/api/capacity":
            if not self._require_admin():
                return
            self._write_json(200, {"capacity": STORE.get_capacity_settings()})
            return

        if parsed.path == "/api/discount-codes":
            if not self._require_admin():
                return
            self._write_json(200, {"discount_codes": STORE.get_discount_codes()})
            return

        if parsed.path == "/api/faq":
            self._write_json(200, {"faq": STORE.get_faq_items(active_only=True)})
            return

        if parsed.path == "/api/admin/faq":
            if not self._require_admin():
                return
            self._write_json(200, {"faq": STORE.get_faq_items(active_only=False)})
            return

        if parsed.path == "/api/discount/validate":
            params = parse_qs(parsed.query)
            code = params.get("code", [""])[0].strip()
            if not code:
                self._write_json(400, {"error": "code 파라미터가 필요합니다."})
                return
            result = STORE.validate_discount_code(code)
            if result:
                self._write_json(200, {
                    "valid": True,
                    "discount_type": result["discount_type"],
                    "discount_value": result["discount_value"],
                })
            else:
                self._write_json(200, {"valid": False})
            return

        if parsed.path == "/api/applications":
            if not self._require_admin():
                return
            self._write_json(200, STORE.list_applications())
            return

        if parsed.path == "/api/applications/export/csv":
            params = parse_qs(parsed.query)
            token_param = params.get("token", [""])[0].strip()
            if token_param:
                if not hmac.compare_digest(token_param, get_admin_token()):
                    self._write_json(401, {"error": "관리자 인증이 필요합니다."})
                    return
            elif not self._require_admin():
                return
            csv_data = STORE.export_applications_csv()
            body = csv_data.encode("utf-8-sig")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="applications.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/api/backup":
            if not self._require_admin():
                return
            backup = STORE.export_backup_json()
            self._write_json(200, backup)
            return

        if parsed.path.startswith("/api/applications/"):
            try:
                application_id = int(parsed.path.rsplit("/", 1)[-1])
            except ValueError:
                self._write_json(400, {"error": "잘못된 신청 ID입니다."})
                return

            application = STORE.get_application(application_id)
            if not application:
                self._write_json(404, {"error": "신청 정보를 찾을 수 없습니다."})
                return

            self._write_json(200, {"application": application, "account": ACCOUNT_INFO})
            return

        if parsed.path == "/api/party-dates":
            stored = STORE.get_site_content_value("party_dates")
            if stored:
                try:
                    dates = json.loads(stored)
                except (json.JSONDecodeError, TypeError):
                    dates = []
            else:
                dates = []
            self._write_json(200, {"dates": dates})
            return

        if parsed.path == "/":
            self.path = "/index.html"

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/auth/login":
            try:
                payload = self._read_payload()
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
                return
            token = str(payload.get("token", "")).strip()
            if hmac.compare_digest(token, get_admin_token()):
                self._write_json(200, {"ok": True, "token": token})
            else:
                self._write_json(401, {"error": "비밀번호가 올바르지 않습니다."})
            return

        if parsed.path == "/api/admin/password":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
                return
            current_pw = str(payload.get("currentPassword", "")).strip()
            new_pw = str(payload.get("newPassword", "")).strip()
            if not hmac.compare_digest(current_pw, get_admin_token()):
                self._write_json(401, {"error": "현재 비밀번호가 올바르지 않습니다."})
                return
            if len(new_pw) < 6:
                self._write_json(400, {"error": "새 비밀번호는 6자 이상이어야 합니다."})
                return
            set_admin_token(new_pw)
            self._write_json(200, {"ok": True})
            return

        if parsed.path == "/api/admin/party-dates":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                dates = payload.get("dates", [])
                if not isinstance(dates, list):
                    self._write_json(400, {"error": "dates는 배열이어야 합니다."})
                    return
                STORE.upsert_site_content({"party_dates": json.dumps(dates, ensure_ascii=False)})
                self._write_json(200, {"ok": True, "dates": dates})
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/capacity":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                day = payload.get("day")
                cap = int(payload.get("capacity", 30))
                if not day or not day.strip():
                    self._write_json(400, {"error": "날짜를 입력해 주세요."})
                    return
                result = STORE.set_capacity(day, cap)
                self._write_json(200, {"capacity": result})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/pricing":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                pricing_json = json.dumps(payload.get("pricing", {}))
                STORE.upsert_site_content({"pricing": pricing_json})
                self._write_json(200, {"ok": True})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/admin/faq":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                question = str(payload.get("question", "")).strip()
                answer = str(payload.get("answer", "")).strip()
                sort_order = int(payload.get("sort_order", 0))
                if not question or not answer:
                    self._write_json(400, {"error": "질문과 답변을 모두 입력해 주세요."})
                    return
                result = STORE.create_faq_item(question, answer, sort_order)
                self._write_json(201, {"faq": result})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/admin/faq/update":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                faq_id = int(payload.get("id", 0))
                question = str(payload.get("question", "")).strip()
                answer = str(payload.get("answer", "")).strip()
                sort_order = int(payload.get("sort_order", 0))
                is_active = int(payload.get("is_active", 1))
                if not faq_id or not question or not answer:
                    self._write_json(400, {"error": "필수 항목이 누락되었습니다."})
                    return
                result = STORE.update_faq_item(faq_id, question, answer, sort_order, is_active)
                if not result:
                    self._write_json(404, {"error": "해당 FAQ를 찾을 수 없습니다."})
                    return
                self._write_json(200, {"faq": result})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/admin/faq/delete":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                faq_id = int(payload.get("id", 0))
                if not faq_id:
                    self._write_json(400, {"error": "FAQ ID가 필요합니다."})
                    return
                STORE.delete_faq_item(faq_id)
                self._write_json(200, {"ok": True})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/site-content":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                content = STORE.upsert_site_content(payload.get("content", {}))
            except ValidationError as exc:
                self._write_json(400, {"error": str(exc)})
                return
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
                return

            self._write_json(200, {"content": content})
            return

        if parsed.path == "/api/discount-codes":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                code = str(payload.get("code", "")).strip()
                discount_type = str(payload.get("discount_type", "fixed")).strip()
                discount_value = int(payload.get("discount_value", 0))
                max_uses = int(payload.get("max_uses", 0))
                if not code:
                    self._write_json(400, {"error": "code 필드가 필요합니다."})
                    return
                if discount_type not in ("fixed", "percent"):
                    self._write_json(400, {"error": "discount_type은 'fixed' 또는 'percent'이어야 합니다."})
                    return
                result = STORE.create_discount_code(code, discount_type, discount_value, max_uses)
                self._write_json(201, {"discount_code": result})
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/admin/discount-codes/update":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                code_id = int(payload.get("id", 0))
                if not code_id:
                    self._write_json(400, {"error": "id 필드가 필요합니다."})
                    return
                updates = {}
                if "discount_type" in payload:
                    dt = str(payload["discount_type"]).strip()
                    if dt not in ("fixed", "percent"):
                        self._write_json(400, {"error": "discount_type은 'fixed' 또는 'percent'이어야 합니다."})
                        return
                    updates["discount_type"] = dt
                if "discount_value" in payload:
                    updates["discount_value"] = int(payload["discount_value"])
                if "max_uses" in payload:
                    updates["max_uses"] = int(payload["max_uses"])
                if "is_active" in payload:
                    updates["is_active"] = int(payload["is_active"])
                result = STORE.update_discount_code(code_id, updates)
                if not result:
                    self._write_json(404, {"error": "할인코드를 찾을 수 없습니다."})
                    return
                self._write_json(200, {"discount_code": result})
            except (json.JSONDecodeError, ValueError):  # pragma: no cover
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            except Exception as exc:  # pragma: no cover
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/admin/discount-codes/delete":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                code_id = int(payload.get("id", 0))
                if not code_id:
                    self._write_json(400, {"error": "id 필드가 필요합니다."})
                    return
                deleted = STORE.delete_discount_code(code_id)
                if not deleted:
                    self._write_json(404, {"error": "할인코드를 찾을 수 없습니다."})
                    return
                self._write_json(200, {"ok": True})
            except (json.JSONDecodeError, ValueError):  # pragma: no cover
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            except Exception as exc:  # pragma: no cover
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/admin/account":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                bank = str(payload.get("bank", "")).strip()
                account_number = str(payload.get("account_number", "")).strip()
                holder = str(payload.get("holder", "")).strip()
                if not bank or not account_number or not holder:
                    self._write_json(400, {"error": "bank, account_number, holder 필드가 필요합니다."})
                    return
                result = STORE.set_account_info({"bank": bank, "account_number": account_number, "holder": holder})
                self._write_json(200, {"account": result})
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/admin/applications/delete":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                application_id = int(str(payload.get("id", "")).strip())
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "유효한 id 필드가 필요합니다."})
                return
            deleted = STORE.delete_application(application_id)
            if not deleted:
                self._write_json(404, {"error": "신청 정보를 찾을 수 없습니다."})
                return
            self._write_json(200, {"ok": True})
            return

        if parsed.path == "/api/admin/applications/bulk-delete":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                ids = payload.get("ids", [])
                if not isinstance(ids, list) or len(ids) == 0:
                    self._write_json(400, {"error": "삭제할 신청 ID 목록이 필요합니다."})
                    return
                if len(ids) > 500:
                    self._write_json(400, {"error": "한 번에 최대 500개까지 삭제할 수 있습니다."})
                    return
                int_ids = []
                for aid in ids:
                    try:
                        int_ids.append(int(aid))
                    except (ValueError, TypeError):
                        continue
                deleted_count = STORE.bulk_delete_applications(int_ids)
                self._write_json(200, {"ok": True, "deleted_count": deleted_count})
            except (json.JSONDecodeError, ValueError):
                self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            except Exception as exc:
                self._write_json(500, {"error": str(exc)})
            return

        if parsed.path != "/api/applications":
            self._write_json(404, {"error": "지원하지 않는 경로입니다."})
            return

        try:
            payload = self._read_payload()
            application = STORE.create_application(payload)
        except ValidationError as exc:
            self._write_json(400, {"error": str(exc)})
            return
        except (json.JSONDecodeError, ValueError):
            self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            return

        discount_code = str(payload.get("discount", "") or payload.get("coupon", "") or "").strip()
        if discount_code:
            try:
                valid = STORE.validate_discount_code(discount_code)
                if valid:
                    STORE.increment_discount_usage(discount_code)
            except Exception:
                pass

        self._write_json(
            201,
            {
                "application": application,
                "account": ACCOUNT_INFO,
            },
        )

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)

        if not parsed.path.startswith("/api/applications/"):
            self._write_json(404, {"error": "지원하지 않는 경로입니다."})
            return

        if not self._require_admin():
            return

        try:
            application_id = int(parsed.path.rsplit("/", 1)[-1])
        except ValueError:
            self._write_json(400, {"error": "잘못된 신청 ID입니다."})
            return

        try:
            payload = self._read_payload()
        except (json.JSONDecodeError, ValueError):
            self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            return

        application = STORE.update_application(application_id, payload)
        if not application:
            self._write_json(404, {"error": "신청 정보를 찾을 수 없습니다."})
            return

        self._write_json(200, {"application": application})

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin") or ""
        if self._is_origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin or "*")
        else:
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0])
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Vary", "Origin")
        super().end_headers()

    _MAX_PAYLOAD = 1_048_576  # 1 MB

    def _read_payload(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > self._MAX_PAYLOAD:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise ValueError("요청 본문이 너무 큽니다.")
        raw_body = self.rfile.read(length) if length > 0 else b""
        content_type = self.headers.get("Content-Type", "")

        if "application/json" in content_type:
            return json.loads(raw_body.decode("utf-8") or "{}")

        if "application/x-www-form-urlencoded" in content_type:
            parsed = parse_qs(raw_body.decode("utf-8"))
            return {key: values[0] for key, values in parsed.items()}

        if not raw_body:
            return {}

        return json.loads(raw_body.decode("utf-8"))

    def _write_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        print(f"[{self.log_date_time_string()}] {format % args}")


def main() -> None:  # pragma: no cover
    handler = partial(PartyRequestHandler, directory=str(ROOT_DIR))
    httpd = http.server.ThreadingHTTPServer(("", PORT), handler)

    if CERT_FILE.exists() and KEY_FILE.exists():
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(CERT_FILE), keyfile=str(KEY_FILE))
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        print(f"Serving HTTPS on https://0.0.0.0:{PORT}")
    else:
        print("Certificate files not found, serving plain HTTP.")
        print(f"Serving HTTP on http://0.0.0.0:{PORT}")

    print(f"Storage backend: {STORE.kind}")
    httpd.serve_forever()


if __name__ == "__main__":  # pragma: no cover
    main()
