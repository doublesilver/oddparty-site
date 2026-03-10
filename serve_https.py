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
        if self.kind == "postgres":
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
                    admin_note TEXT NOT NULL
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

    def get_capacity_settings(self) -> dict:
        if self.kind == "postgres":
            rows = self._query_all_postgres("SELECT day_key, capacity FROM capacity_settings")
            settings = {r["day_key"]: r["capacity"] for r in rows}
        else:
            with self._sqlite_connection() as conn:
                rows = conn.execute("SELECT day_key, capacity FROM capacity_settings").fetchall()
            settings = {r[0]: r[1] for r in rows}
        # defaults
        for day in ("금요일", "토요일", "일요일"):
            if day not in settings:
                settings[day] = 30
        return settings

    def set_capacity(self, day_key: str, capacity: int) -> dict:
        if self.kind == "postgres":
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
        if self.kind == "postgres":
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
        result = {}
        for day in ("금요일", "토요일", "일요일"):
            cap = caps.get(day, 30)
            count = counts.get(day, 0)
            ratio = count / cap if cap > 0 else 0
            if ratio >= 1:
                level = "마감"
            elif ratio >= 0.8:
                level = "마감임박"
            elif ratio >= 0.5:
                level = "잔여 소수"
            else:
                level = "여유"
            result[day] = {"capacity": cap, "count": count, "level": level}
        return result

    def create_application(self, payload: dict) -> dict:
        normalized = self._normalize_payload(payload)

        if self.kind == "postgres":
            application_id = self._insert_postgres(normalized)
            return self.get_application(application_id)

        with self._sqlite_connection() as connection:
            cursor = connection.execute(
                """
                INSERT INTO applications (
                    name, age, phone, branch, price_text, price_amount,
                    location_note, party_date, coupon, status, admin_note
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            application_id = cursor.lastrowid

        return self.get_application(application_id)

    def get_application(self, application_id: int) -> dict | None:
        if self.kind == "postgres":
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
        if self.kind == "postgres":
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
        allowed_fields = {"status", "admin_note"}
        filtered = {k: str(v).strip() for k, v in updates.items() if k in allowed_fields and v is not None}
        if not filtered:
            return self.get_application(application_id)

        existing = self.get_application(application_id)
        if not existing:
            return None

        if self.kind == "postgres":
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
        writer.writerow(["ID", "접수시간", "이름", "나이", "전화번호", "지점", "가격", "금액", "지점안내", "희망일정", "할인코드", "상태", "메모"])
        for app in data["applications"]:
            writer.writerow([
                app["id"], app["createdAt"], app["name"], app["age"],
                app["phone"], app["branch"], app["priceText"], app["priceAmount"],
                app["locationNote"], app["partyDate"], app["coupon"] or "",
                app["status"], app["adminNote"],
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
        if self.kind == "postgres":
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

        if self.kind == "postgres":
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
        if self.kind == "postgres":
            rows = self._query_all_postgres("SELECT * FROM discount_codes ORDER BY id DESC")
        else:
            with self._sqlite_connection() as conn:
                rows = conn.execute("SELECT * FROM discount_codes ORDER BY id DESC").fetchall()
        return [dict(row) for row in rows]

    def create_discount_code(self, code: str, discount_type: str, discount_value: int, max_uses: int) -> dict:
        if self.kind == "postgres":
            row = self._query_one_postgres(
                """
                INSERT INTO discount_codes (code, discount_type, discount_value, max_uses)
                VALUES (%s, %s, %s, %s)
                RETURNING *
                """,
                (code, discount_type, discount_value, max_uses),
            )
            return dict(row)
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
            return dict(row)

    def validate_discount_code(self, code: str) -> dict | None:
        if self.kind == "postgres":
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
        data = dict(row)
        if data["max_uses"] > 0 and data["used_count"] >= data["max_uses"]:
            return None
        return data

    def increment_discount_usage(self, code: str) -> None:
        if self.kind == "postgres":
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

    def _normalize_payload(self, payload: dict) -> dict:
        name = self._require_text(payload.get("name"), "이름", 40)
        phone = re.sub(r"[^0-9]", "", str(payload.get("phone", "")))
        if len(phone) < 11 or len(phone) > 14:
            raise ValidationError("전화번호는 하이픈 없이 11자리 이상 입력해 주세요.")

        try:
            age = int(str(payload.get("age", "")).strip())
        except ValueError as exc:
            raise ValidationError("나이는 숫자로 입력해 주세요.") from exc

        if age < 1 or age > 99:
            raise ValidationError("나이는 1세 이상 99세 이하로 입력해 주세요.")

        branch, price_text, location_note, price_amount = self._parse_location(
            payload.get("location")
        )
        party_date = self._require_text(payload.get("partyDate"), "참여 날짜", 80)
        coupon = str(payload.get("coupon", "")).strip() or None
        if coupon and len(coupon) > 40:
            raise ValidationError("할인코드는 40자 이내로 입력해 주세요.")

        is_closed_branch = price_amount == 0 or location_note == "마감"
        status = "보류" if is_closed_branch else "입금대기"
        admin_note = (
            "현재 마감되어 확인필요"
            if is_closed_branch
            else ("할인코드 확인 필요" if coupon else "신규 신청 접수")
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
            "coupon": coupon,
            "status": status,
            "admin_note": admin_note,
        }

    def _parse_location(self, raw_value: object) -> tuple[str, str, str, int]:
        raw_text = self._require_text(raw_value, "지점 정보", 120)
        parts = [part.strip() for part in raw_text.split("|")]
        if len(parts) != 3:
            raise ValidationError("지점 정보를 다시 선택해 주세요.")

        branch, price_text, location_note = parts
        digits = re.sub(r"[^0-9]", "", price_text)
        price_amount = int(digits) if digits else 0
        return branch, price_text, location_note, price_amount

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

    def _init_postgres(self) -> None:
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

    def _insert_postgres(self, normalized: dict) -> int:
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

    def _query_one_postgres(self, query: str, params: tuple = ()) -> dict | None:
        from psycopg.rows import dict_row

        with self._postgres_connection(row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(query, params)
                return cursor.fetchone()

    def _query_all_postgres(self, query: str, params: tuple = ()) -> list[dict]:
        from psycopg.rows import dict_row

        with self._postgres_connection(row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute(query, params)
                return cursor.fetchall()

    def _postgres_connection(self, **kwargs):
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
                except ValueError:
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

        if parsed.path == "/api/scarcity":
            result = {"dates": STORE.get_scarcity_info()}
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
            if not self._require_admin():
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

        if parsed.path == "/":
            self.path = "/index.html"

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/auth/login":
            try:
                payload = self._read_payload()
            except json.JSONDecodeError:
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
            except json.JSONDecodeError:
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

        if parsed.path == "/api/capacity":
            if not self._require_admin():
                return
            try:
                payload = self._read_payload()
                day = payload.get("day")
                cap = int(payload.get("capacity", 30))
                if day not in ("금요일", "토요일", "일요일"):
                    self._write_json(400, {"error": "Invalid day"})
                    return
                result = STORE.set_capacity(day, cap)
                self._write_json(200, {"capacity": result})
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
            except json.JSONDecodeError:
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
            except json.JSONDecodeError:
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
        except json.JSONDecodeError:
            self._write_json(400, {"error": "요청 본문 형식이 올바르지 않습니다."})
            return

        discount_code = str(payload.get("discount", "") or payload.get("coupon", "") or "").strip()
        if discount_code:
            try:
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
        except json.JSONDecodeError:
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

    def _read_payload(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
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


def main() -> None:
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


if __name__ == "__main__":
    main()
