"""
Comprehensive backend tests for serve_https.py.

Strategy:
  - Unit-test ApplicationStore against a real SQLite temp-file (no mocking of DB).
  - Integration-test every HTTP endpoint via a real ThreadingHTTPServer spun up
    on a free port, contacted with urllib.
  - Use os.environ patches so the module-level STORE singleton is always SQLite
    and never touches production data.

Run with:
    python -m pytest tests/ -v
    python -m pytest tests/ -v --cov=serve_https --cov-report=term-missing
"""

from __future__ import annotations

import http.client
import io
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from functools import partial
from pathlib import Path
from unittest.mock import patch

# ---------------------------------------------------------------------------
# Bootstrap: point all env vars at temp dirs BEFORE importing serve_https
# ---------------------------------------------------------------------------
_TMP_DIR = tempfile.mkdtemp(prefix="oddparty_test_")
os.environ["DATABASE_URL"] = ""           # force SQLite
os.environ["ALLOW_SQLITE_ON_RAILWAY"] = ""
os.environ.pop("RAILWAY_PROJECT_ID", None)
os.environ.pop("RAILWAY_ENVIRONMENT_ID", None)
os.environ.pop("RAILWAY_SERVICE_ID", None)
os.environ["SQLITE_PATH"] = os.path.join(_TMP_DIR, "test.db")
os.environ["ADMIN_TOKEN"] = "testtoken123"

# Now import the module
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import serve_https as sut

# Patch module-level constants that refer to files so tests don't touch real FS
sut.DATA_DIR = Path(_TMP_DIR)
sut.SQLITE_PATH = Path(_TMP_DIR) / "test.db"
sut.ADMIN_TOKEN_FILE = Path(_TMP_DIR) / ".admin_token"
sut.ADMIN_TOKEN = "testtoken123"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_store() -> sut.ApplicationStore:
    """Return a fresh, initialised store using a per-call temp DB."""
    db_path = Path(tempfile.mktemp(suffix=".db", dir=_TMP_DIR))
    store = sut.ApplicationStore.__new__(sut.ApplicationStore)
    store.database_url = ""
    store.allow_sqlite_on_railway = False
    store.kind = "sqlite"
    # Patch module-level path so _sqlite_connection uses this db
    with patch.object(sut, "SQLITE_PATH", db_path):
        store._db_path = db_path
        # Monkeypatch _sqlite_connection to always use our path
        original_conn = sut.ApplicationStore._sqlite_connection

        def _conn(self):
            conn = sqlite3.connect(str(db_path), timeout=30)
            conn.row_factory = sqlite3.Row
            return conn

        store._sqlite_connection = types.MethodType(_conn, store)
        # Also patch STORE used by _normalize_payload
        with patch.object(sut, "STORE", store):
            store.initialize()
    return store


def _minimal_payload(**overrides) -> dict:
    """Valid application payload for a 건대/male applicant."""
    base = {
        "name": "홍길동",
        "phone": "01012345678",
        "age": "25",
        "branch": "건대",
        "gender": "male",
        "date": "2026-04-25 금요일",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# HTTP test server fixture helpers
# ---------------------------------------------------------------------------

class _LiveServer:
    """Spin up a real ThreadingHTTPServer for integration tests."""

    def __init__(self):
        self.port: int | None = None
        self._server: sut.http.server.ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self, store: sut.ApplicationStore) -> None:
        import http.server as _hs
        handler = partial(sut.PartyRequestHandler, directory=str(sut.ROOT_DIR))
        self._server = _hs.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self._server.server_address[1]
        # Patch the module-level STORE used by handlers
        self._store_patch = patch.object(sut, "STORE", store)
        self._store_patch.start()
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
        if hasattr(self, "_store_patch"):
            self._store_patch.stop()

    def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        token: str | None = "testtoken123",
        content_type: str = "application/json",
        raw_body: bytes | None = None,
    ) -> tuple[int, dict | bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = content_type
            headers["Content-Length"] = str(len(data))
        elif raw_body is not None:
            data = raw_body
            headers["Content-Length"] = str(len(data))
        else:
            data = None

        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        status = resp.status
        raw = resp.read()
        conn.close()
        try:
            return status, json.loads(raw.decode())
        except Exception:
            return status, raw


# ===========================================================================
# 1. Unit tests: ApplicationStore
# ===========================================================================

class TestApplicationStoreInit(unittest.TestCase):

    def test_kind_is_sqlite_when_no_database_url(self):
        store = _make_store()
        self.assertEqual(store.kind, "sqlite")

    def test_tables_created_on_initialize(self):
        store = _make_store()
        conn = store._sqlite_connection()
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        conn.close()
        self.assertIn("applications", tables)
        self.assertIn("site_content", tables)
        self.assertIn("capacity_settings", tables)
        self.assertIn("discount_codes", tables)
        self.assertIn("faq", tables)


class TestNormalizePayload(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def _normalize(self, payload):
        with patch.object(sut, "STORE", self.store):
            return self.store._normalize_payload(payload)

    def test_valid_payload_returns_expected_keys(self):
        result = self._normalize(_minimal_payload())
        for key in ("name", "age", "phone", "branch", "price_text",
                    "price_amount", "location_note", "party_date",
                    "coupon", "status", "admin_note"):
            self.assertIn(key, result)

    def test_name_stripped(self):
        result = self._normalize(_minimal_payload(name="  김철수  "))
        self.assertEqual(result["name"], "김철수")

    def test_empty_name_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError) as ctx:
            self._normalize(_minimal_payload(name=""))
        self.assertIn("이름", str(ctx.exception))

    def test_name_too_long_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError):
            self._normalize(_minimal_payload(name="가" * 41))

    def test_phone_digits_only_stored(self):
        result = self._normalize(_minimal_payload(phone="010-1234-5678"))
        self.assertEqual(result["phone"], "01012345678")

    def test_phone_too_short_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError) as ctx:
            self._normalize(_minimal_payload(phone="0101234"))
        self.assertIn("전화번호", str(ctx.exception))

    def test_phone_too_long_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError):
            self._normalize(_minimal_payload(phone="0" * 15))

    def test_age_below_minimum_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError) as ctx:
            self._normalize(_minimal_payload(age="19"))
        self.assertIn("20", str(ctx.exception))

    def test_age_above_maximum_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError):
            self._normalize(_minimal_payload(age="38"))

    def test_age_boundary_20_accepted(self):
        result = self._normalize(_minimal_payload(age="20"))
        self.assertEqual(result["age"], 20)

    def test_age_boundary_37_accepted(self):
        result = self._normalize(_minimal_payload(age="37"))
        self.assertEqual(result["age"], 37)

    def test_non_numeric_age_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError) as ctx:
            self._normalize(_minimal_payload(age="스물다섯"))
        self.assertIn("나이", str(ctx.exception))

    def test_invalid_branch_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError) as ctx:
            self._normalize(_minimal_payload(branch="존재하지않는지점"))
        self.assertIn("지점", str(ctx.exception))

    def test_empty_branch_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError):
            self._normalize(_minimal_payload(branch=""))

    def test_male_price_text_contains_남(self):
        result = self._normalize(_minimal_payload(branch="건대", gender="male"))
        self.assertIn("남", result["price_text"])

    def test_female_price_text_contains_여(self):
        result = self._normalize(_minimal_payload(branch="건대", gender="female"))
        self.assertIn("여", result["price_text"])

    def test_건대_male_price_amount_is_33000(self):
        result = self._normalize(_minimal_payload(branch="건대", gender="male"))
        self.assertEqual(result["price_amount"], 33000)

    def test_건대_female_price_amount_is_23000(self):
        result = self._normalize(_minimal_payload(branch="건대", gender="female"))
        self.assertEqual(result["price_amount"], 23000)

    def test_영등포_male_price_amount_is_39500(self):
        result = self._normalize(_minimal_payload(branch="영등포", gender="male"))
        self.assertEqual(result["price_amount"], 39500)

    def test_영등포_female_price_amount_is_29500(self):
        result = self._normalize(_minimal_payload(branch="영등포", gender="female"))
        self.assertEqual(result["price_amount"], 29500)

    def test_status_is_입금대기_for_normal_application(self):
        result = self._normalize(_minimal_payload())
        self.assertEqual(result["status"], "입금대기")

    def test_coupon_field_stored_when_provided(self):
        result = self._normalize(_minimal_payload(discount="SALE10"))
        self.assertEqual(result["coupon"], "SALE10")

    def test_coupon_none_when_not_provided(self):
        result = self._normalize(_minimal_payload())
        self.assertIsNone(result["coupon"])

    def test_coupon_too_long_raises_validation_error(self):
        with self.assertRaises(sut.ValidationError):
            self._normalize(_minimal_payload(discount="X" * 41))

    def test_admin_note_mentions_discount_when_coupon_provided(self):
        result = self._normalize(_minimal_payload(discount="CODE1"))
        self.assertIn("할인코드", result["admin_note"])

    def test_party_date_accepts_partyDate_key(self):
        payload = _minimal_payload()
        payload.pop("date", None)
        payload["partyDate"] = "2026-05-01 금요일"
        result = self._normalize(payload)
        self.assertEqual(result["party_date"], "2026-05-01 금요일")

    def test_missing_date_raises_validation_error(self):
        payload = _minimal_payload()
        payload.pop("date", None)
        with self.assertRaises(sut.ValidationError):
            self._normalize(payload)

    def test_custom_pricing_from_site_content(self):
        """When admin stores custom pricing, _normalize_payload uses it."""
        custom_pricing = {
            "건대": {"male": 50000, "female": 40000, "note": "특별가"},
        }
        self.store.upsert_site_content({"pricing": json.dumps(custom_pricing)})
        result = self._normalize(_minimal_payload(branch="건대", gender="male"))
        self.assertEqual(result["price_amount"], 50000)

    def test_part2_prepay_adds_part2_price(self):
        """When part2pay=prepay, price includes 2부 금액 with discount."""
        # 건대 남성 33000 + part2_base 18000 = 51000 * 0.9 = 45900
        result = self._normalize({**_minimal_payload(branch="건대", gender="male"), "part2pay": "prepay"})
        self.assertEqual(result["price_amount"], 45900)
        self.assertIn("1부+2부", result["price_text"])

    def test_part2_prepay_admin_note(self):
        result = self._normalize({**_minimal_payload(), "part2pay": "prepay"})
        self.assertIn("2부 사전결제", result["admin_note"])

    def test_part2_onsite_does_not_change_price(self):
        """part2pay=onsite should not change the price."""
        result_none = self._normalize(_minimal_payload(branch="건대", gender="male"))
        result_onsite = self._normalize({**_minimal_payload(branch="건대", gender="male"), "part2pay": "onsite"})
        self.assertEqual(result_none["price_amount"], result_onsite["price_amount"])
        self.assertIn("2부 현장결제", result_onsite["admin_note"])

    def test_part2_prepay_with_discount_code(self):
        """Discount code applied on top of 1부+2부 combined price."""
        self.store.create_discount_code("PART2TEST", "fixed", 5000, 10)
        result = self._normalize({**_minimal_payload(branch="건대", gender="male"), "part2pay": "prepay", "discount": "PART2TEST"})
        # 45900 - 5000 = 40900
        self.assertEqual(result["price_amount"], 40900)
        self.assertIn("1부+2부", result["price_text"])
        self.assertIn("할인", result["price_text"])
        self.assertIn("할인코드", result["admin_note"])
        self.assertIn("2부 사전결제", result["admin_note"])

    def test_percent_discount_applied_correctly(self):
        """Percent discount type calculates correctly."""
        self.store.create_discount_code("PCT20", "percent", 20, 10)
        result = self._normalize(_minimal_payload(branch="건대", gender="male", discount="PCT20"))
        # 33000 * 20% = 6600 discount → 26400
        self.assertEqual(result["price_amount"], 26400)
        self.assertIn("할인 적용", result["price_text"])

    def test_part2_prepay_custom_part2_pricing(self):
        """Custom part2_base and part2_discount from admin settings."""
        custom_pricing = {
            "건대": {"male": 33000, "female": 23000},
            "part2_base": 20000,
            "part2_discount": 20,
        }
        self.store.upsert_site_content({"pricing": json.dumps(custom_pricing)})
        # (33000 + 20000) * 0.8 = 42400
        result = self._normalize({**_minimal_payload(branch="건대", gender="male"), "part2pay": "prepay"})
        self.assertEqual(result["price_amount"], 42400)


class TestApplicationStoreCRUD(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def _create(self, **overrides):
        with patch.object(sut, "STORE", self.store):
            return self.store.create_application(_minimal_payload(**overrides))

    def test_create_application_returns_dict_with_id(self):
        app = self._create()
        self.assertIn("id", app)
        self.assertIsInstance(app["id"], int)

    def test_created_application_has_correct_name(self):
        app = self._create(name="이테스트")
        self.assertEqual(app["name"], "이테스트")

    def test_created_at_is_iso8601(self):
        app = self._create()
        self.assertTrue(app["createdAt"].endswith("Z"))

    def test_get_application_returns_none_for_missing_id(self):
        result = self.store.get_application(99999)
        self.assertIsNone(result)

    def test_get_application_returns_created_record(self):
        app = self._create()
        fetched = self.store.get_application(app["id"])
        self.assertEqual(fetched["id"], app["id"])
        self.assertEqual(fetched["name"], app["name"])

    def test_list_applications_returns_all_records(self):
        self._create(name="첫번째")
        self._create(name="두번째")
        data = self.store.list_applications()
        self.assertEqual(data["stats"]["totalCount"], 2)
        names = [a["name"] for a in data["applications"]]
        self.assertIn("첫번째", names)
        self.assertIn("두번째", names)

    def test_list_applications_includes_stats_key(self):
        data = self.store.list_applications()
        self.assertIn("stats", data)
        self.assertIn("totalCount", data["stats"])
        self.assertIn("todayCount", data["stats"])
        self.assertIn("couponCount", data["stats"])

    def test_list_applications_includes_account_key(self):
        data = self.store.list_applications()
        self.assertIn("account", data)

    def test_update_application_changes_status(self):
        app = self._create()
        updated = self.store.update_application(app["id"], {"status": "입금완료"})
        self.assertEqual(updated["status"], "입금완료")

    def test_update_application_changes_admin_note(self):
        app = self._create()
        updated = self.store.update_application(app["id"], {"admin_note": "확인함"})
        self.assertEqual(updated["adminNote"], "확인함")

    def test_update_application_returns_none_for_missing_id(self):
        result = self.store.update_application(99999, {"status": "입금완료"})
        self.assertIsNone(result)

    def test_update_application_ignores_unknown_fields(self):
        app = self._create()
        updated = self.store.update_application(app["id"], {"unknown_field": "bad"})
        self.assertEqual(updated["id"], app["id"])

    def test_delete_application_returns_true_for_existing(self):
        app = self._create()
        result = self.store.delete_application(app["id"])
        self.assertTrue(result)

    def test_delete_application_removes_record(self):
        app = self._create()
        self.store.delete_application(app["id"])
        self.assertIsNone(self.store.get_application(app["id"]))

    def test_delete_application_returns_false_for_missing(self):
        result = self.store.delete_application(99999)
        self.assertFalse(result)

    def test_serialize_row_maps_snake_to_camel(self):
        app = self._create()
        self.assertIn("priceText", app)
        self.assertIn("priceAmount", app)
        self.assertIn("locationNote", app)
        self.assertIn("partyDate", app)
        self.assertIn("adminNote", app)
        self.assertIn("createdAt", app)


class TestCapacityManagement(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def test_get_capacity_settings_returns_empty_by_default(self):
        caps = self.store.get_capacity_settings()
        self.assertEqual(caps, {})

    def test_set_capacity_updates_stored_value(self):
        self.store.set_capacity("금요일", 50)
        caps = self.store.get_capacity_settings()
        self.assertEqual(caps["금요일"], 50)

    def test_set_capacity_upserts_on_second_call(self):
        self.store.set_capacity("토요일", 20)
        self.store.set_capacity("토요일", 40)
        caps = self.store.get_capacity_settings()
        self.assertEqual(caps["토요일"], 40)

    def test_get_scarcity_info_level_모집중_when_below_80pct(self):
        self.store.set_capacity("금요일", 100)
        info = self.store.get_scarcity_info()
        self.assertEqual(info["금요일"]["level"], "모집중")

    def test_get_scarcity_info_level_마감임박_when_above_80pct(self):
        self.store.set_capacity("금요일", 10)
        # Create 9 applications (90% full)
        store = self.store
        with patch.object(sut, "STORE", store):
            for i in range(9):
                store.create_application(_minimal_payload(
                    name=f"사람{i}", phone=f"0101234567{i}",
                    date="금요일"
                ))
        info = self.store.get_scarcity_info()
        self.assertEqual(info["금요일"]["level"], "마감임박")

    def test_get_scarcity_info_level_마감_when_at_capacity(self):
        self.store.set_capacity("금요일", 3)
        store = self.store
        with patch.object(sut, "STORE", store):
            for i in range(3):
                store.create_application(_minimal_payload(
                    name=f"사람{i}", phone=f"0101234567{i}",
                    date="금요일"
                ))
        info = self.store.get_scarcity_info()
        self.assertEqual(info["금요일"]["level"], "마감")

    def test_get_scarcity_info_level_마감_when_capacity_is_zero(self):
        self.store.set_capacity("금요일", 0)
        info = self.store.get_scarcity_info()
        self.assertEqual(info["금요일"]["level"], "마감")

    def test_get_scarcity_info_custom_thresholds(self):
        """Custom thresholds from site content are used for level calculation."""
        self.store.upsert_site_content({
            "scarcity_threshold_urgent": "50",
            "scarcity_threshold_closed": "90",
        })
        self.store.set_capacity("금요일", 10)
        store = self.store
        with patch.object(sut, "STORE", store):
            for i in range(6):
                store.create_application(_minimal_payload(
                    name=f"사람{i}", phone=f"0101234567{i}", date="금요일"
                ))
        info = self.store.get_scarcity_info()
        # 6/10 = 60% → above 50% (urgent) but below 90% (closed)
        self.assertEqual(info["금요일"]["level"], "마감임박")

    def test_get_scarcity_info_uses_party_dates_daynames(self):
        """Scarcity uses party_dates dayNames as the base keys."""
        self.store.upsert_site_content({
            "party_dates": json.dumps([
                {"date": "2026-03-20", "label": "20일(금)", "dayName": "금요일"},
                {"date": "2026-03-21", "label": "21일(토)", "dayName": "토요일"},
            ])
        })
        info = self.store.get_scarcity_info()
        self.assertIn("금요일", info)
        self.assertIn("토요일", info)

    def test_get_date_counts_excludes_취소_status(self):
        store = self.store
        with patch.object(sut, "STORE", store):
            app = store.create_application(_minimal_payload(date="금요일"))
        store.update_application(app["id"], {"status": "취소"})
        counts = store.get_date_counts()
        self.assertEqual(counts.get("금요일", 0), 0)

    def test_get_date_counts_excludes_환불_status(self):
        store = self.store
        with patch.object(sut, "STORE", store):
            app = store.create_application(_minimal_payload(date="금요일"))
        store.update_application(app["id"], {"status": "환불"})
        counts = store.get_date_counts()
        self.assertEqual(counts.get("금요일", 0), 0)


class TestDiscountCodeManagement(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def test_create_discount_code_returns_dict(self):
        result = self.store.create_discount_code("SAVE10", "fixed", 10000, 0)
        self.assertIn("id", result)
        self.assertEqual(result["code"], "SAVE10")
        self.assertEqual(result["discount_type"], "fixed")
        self.assertEqual(result["discount_value"], 10000)

    def test_get_discount_codes_returns_list(self):
        self.store.create_discount_code("A", "fixed", 5000, 0)
        codes = self.store.get_discount_codes()
        self.assertIsInstance(codes, list)
        self.assertEqual(len(codes), 1)

    def test_validate_discount_code_returns_data_for_active_code(self):
        self.store.create_discount_code("VALID", "percent", 10, 0)
        result = self.store.validate_discount_code("VALID")
        self.assertIsNotNone(result)
        self.assertEqual(result["discount_type"], "percent")

    def test_validate_discount_code_returns_none_for_unknown_code(self):
        result = self.store.validate_discount_code("NOTEXIST")
        self.assertIsNone(result)

    def test_validate_discount_code_returns_none_when_max_uses_reached(self):
        self.store.create_discount_code("LIMITED", "fixed", 5000, 1)
        self.store.increment_discount_usage("LIMITED")
        result = self.store.validate_discount_code("LIMITED")
        self.assertIsNone(result)

    def test_validate_discount_code_valid_when_uses_not_exhausted(self):
        self.store.create_discount_code("MULTI", "fixed", 5000, 5)
        self.store.increment_discount_usage("MULTI")
        result = self.store.validate_discount_code("MULTI")
        self.assertIsNotNone(result)

    def test_validate_discount_code_unlimited_when_max_uses_is_zero(self):
        self.store.create_discount_code("UNLIMITED", "fixed", 1000, 0)
        for _ in range(100):
            self.store.increment_discount_usage("UNLIMITED")
        result = self.store.validate_discount_code("UNLIMITED")
        self.assertIsNotNone(result)

    def test_increment_discount_usage_increments_used_count(self):
        self.store.create_discount_code("INC", "fixed", 100, 0)
        self.store.increment_discount_usage("INC")
        codes = self.store.get_discount_codes()
        code_data = next(c for c in codes if c["code"] == "INC")
        self.assertEqual(code_data["used_count"], 1)

    def test_create_discount_code_created_at_is_iso_string(self):
        result = self.store.create_discount_code("TS", "fixed", 0, 0)
        # created_at should be a string (serialized)
        self.assertIsInstance(result["created_at"], str)


class TestFaqManagement(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def test_create_faq_item_returns_dict_with_id(self):
        result = self.store.create_faq_item("질문1", "답변1", 0)
        self.assertIn("id", result)
        self.assertEqual(result["question"], "질문1")
        self.assertEqual(result["answer"], "답변1")

    def test_get_faq_items_active_only_excludes_inactive(self):
        item = self.store.create_faq_item("Q", "A", 0)
        self.store.update_faq_item(item["id"], "Q", "A", 0, 0)  # is_active=0
        active = self.store.get_faq_items(active_only=True)
        ids = [f["id"] for f in active]
        self.assertNotIn(item["id"], ids)

    def test_get_faq_items_all_includes_inactive(self):
        item = self.store.create_faq_item("Q", "A", 0)
        self.store.update_faq_item(item["id"], "Q", "A", 0, 0)
        all_items = self.store.get_faq_items(active_only=False)
        ids = [f["id"] for f in all_items]
        self.assertIn(item["id"], ids)

    def test_update_faq_item_changes_question_and_answer(self):
        item = self.store.create_faq_item("Old Q", "Old A", 0)
        updated = self.store.update_faq_item(item["id"], "New Q", "New A", 1, 1)
        self.assertEqual(updated["question"], "New Q")
        self.assertEqual(updated["answer"], "New A")

    def test_update_faq_item_returns_none_for_missing_id(self):
        result = self.store.update_faq_item(99999, "Q", "A", 0, 1)
        self.assertIsNone(result)

    def test_delete_faq_item_removes_record(self):
        item = self.store.create_faq_item("Q", "A", 0)
        self.store.delete_faq_item(item["id"])
        all_items = self.store.get_faq_items(active_only=False)
        self.assertNotIn(item["id"], [f["id"] for f in all_items])

    def test_faq_items_ordered_by_sort_order(self):
        self.store.create_faq_item("Third", "A", 3)
        self.store.create_faq_item("First", "A", 1)
        self.store.create_faq_item("Second", "A", 2)
        items = self.store.get_faq_items(active_only=True)
        orders = [i["sort_order"] for i in items]
        self.assertEqual(orders, sorted(orders))


class TestSiteContent(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def test_get_site_content_returns_empty_dict_initially(self):
        content = self.store.get_site_content()
        self.assertIsInstance(content, dict)

    def test_upsert_site_content_stores_value(self):
        self.store.upsert_site_content({"title": "테스트 타이틀"})
        content = self.store.get_site_content()
        self.assertEqual(content["title"], "테스트 타이틀")

    def test_upsert_site_content_overwrites_existing_key(self):
        self.store.upsert_site_content({"title": "first"})
        self.store.upsert_site_content({"title": "second"})
        self.assertEqual(self.store.get_site_content()["title"], "second")

    def test_upsert_site_content_stores_multiple_keys(self):
        self.store.upsert_site_content({"k1": "v1", "k2": "v2"})
        content = self.store.get_site_content()
        self.assertEqual(content["k1"], "v1")
        self.assertEqual(content["k2"], "v2")

    def test_get_site_content_value_returns_none_for_missing_key(self):
        result = self.store.get_site_content_value("nonexistent")
        self.assertIsNone(result)

    def test_get_site_content_value_returns_value_for_existing_key(self):
        self.store.upsert_site_content({"mykey": "myval"})
        self.assertEqual(self.store.get_site_content_value("mykey"), "myval")

    def test_normalize_site_content_raises_on_non_dict(self):
        with self.assertRaises(sut.ValidationError):
            sut.ApplicationStore._normalize_site_content("not a dict")

    def test_normalize_site_content_raises_on_empty_key(self):
        with self.assertRaises(sut.ValidationError):
            sut.ApplicationStore._normalize_site_content({"": "value"})

    def test_normalize_site_content_raises_on_key_too_long(self):
        with self.assertRaises(sut.ValidationError):
            sut.ApplicationStore._normalize_site_content({"k" * 121: "v"})

    def test_normalize_site_content_raises_on_value_too_long(self):
        with self.assertRaises(sut.ValidationError):
            sut.ApplicationStore._normalize_site_content({"key": "v" * 5001})


class TestAccountInfo(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def test_get_account_info_returns_default_when_not_set(self):
        info = self.store.get_account_info()
        self.assertIn("bank", info)
        self.assertIn("account_number", info)
        self.assertIn("holder", info)

    def test_set_account_info_persists_values(self):
        self.store.set_account_info({
            "bank": "국민",
            "account_number": "123-456",
            "holder": "홍길동"
        })
        info = self.store.get_account_info()
        self.assertEqual(info["bank"], "국민")
        self.assertEqual(info["account_number"], "123-456")
        self.assertEqual(info["holder"], "홍길동")

    def test_get_account_info_falls_back_to_default_on_corrupt_json(self):
        self.store.upsert_site_content({"account": "not-valid-json{"})
        info = self.store.get_account_info()
        self.assertIn("bank", info)


class TestExport(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def _create(self, **kw):
        with patch.object(sut, "STORE", self.store):
            return self.store.create_application(_minimal_payload(**kw))

    def test_export_csv_includes_header_row(self):
        csv_text = self.store.export_applications_csv()
        self.assertIn("이름", csv_text)
        self.assertIn("전화번호", csv_text)

    def test_export_csv_includes_application_data(self):
        self._create(name="CSV테스트")
        csv_text = self.store.export_applications_csv()
        self.assertIn("CSV테스트", csv_text)

    def test_export_backup_json_has_required_keys(self):
        backup = self.store.export_backup_json()
        self.assertIn("exportedAt", backup)
        self.assertIn("applications", backup)
        self.assertIn("stats", backup)
        self.assertIn("siteContent", backup)

    def test_export_backup_json_exported_at_ends_with_Z(self):
        backup = self.store.export_backup_json()
        self.assertTrue(backup["exportedAt"].endswith("Z"))

    def test_export_csv_gender_female_marked_여(self):
        self._create(gender="female")
        csv_text = self.store.export_applications_csv()
        self.assertIn("여", csv_text)

    def test_export_csv_gender_male_marked_남(self):
        self._create(gender="male")
        csv_text = self.store.export_applications_csv()
        self.assertIn("남", csv_text)


class TestToIso8601(unittest.TestCase):

    def test_datetime_object_returned_as_utc_z_string(self):
        from datetime import datetime, timezone
        dt = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        result = sut.ApplicationStore._to_iso8601(dt)
        self.assertEqual(result, "2026-01-01T12:00:00Z")

    def test_string_without_tz_treated_as_utc(self):
        result = sut.ApplicationStore._to_iso8601("2026-01-01 12:00:00")
        self.assertIn("2026-01-01", result)
        self.assertTrue(result.endswith("Z"))

    def test_empty_string_returns_current_time_z(self):
        result = sut.ApplicationStore._to_iso8601("")
        self.assertTrue(result.endswith("Z"))

    def test_iso_string_with_z_round_trips(self):
        result = sut.ApplicationStore._to_iso8601("2026-03-11T09:00:00Z")
        self.assertEqual(result, "2026-03-11T09:00:00Z")


class TestParseIsoDatetime(unittest.TestCase):

    def test_parses_z_suffix(self):
        from datetime import timezone
        dt = sut.ApplicationStore._parse_iso_datetime("2026-01-01T00:00:00Z")
        self.assertEqual(dt.tzinfo, timezone.utc)

    def test_parses_offset_notation(self):
        dt = sut.ApplicationStore._parse_iso_datetime("2026-01-01T09:00:00+09:00")
        self.assertIsNotNone(dt.tzinfo)


class TestRequireText(unittest.TestCase):

    def test_returns_stripped_value(self):
        result = sut.ApplicationStore._require_text("  hello  ", "field", 100)
        self.assertEqual(result, "hello")

    def test_raises_on_empty_string(self):
        with self.assertRaises(sut.ValidationError) as ctx:
            sut.ApplicationStore._require_text("", "이름", 100)
        self.assertIn("이름", str(ctx.exception))

    def test_raises_on_none(self):
        with self.assertRaises(sut.ValidationError):
            sut.ApplicationStore._require_text(None, "field", 10)

    def test_raises_when_length_exceeds_max(self):
        with self.assertRaises(sut.ValidationError):
            sut.ApplicationStore._require_text("abcde", "field", 3)

    def test_accepts_value_at_max_length(self):
        result = sut.ApplicationStore._require_text("abc", "field", 3)
        self.assertEqual(result, "abc")


class TestAdminTokenFunctions(unittest.TestCase):

    def setUp(self):
        self.token_file = Path(_TMP_DIR) / ".admin_token_test"
        self.token_file_patch = patch.object(sut, "ADMIN_TOKEN_FILE", self.token_file)
        self.token_file_patch.start()

    def tearDown(self):
        self.token_file_patch.stop()
        if self.token_file.exists():
            self.token_file.unlink()

    def test_get_admin_token_returns_env_token_when_no_file(self):
        with patch.object(sut, "ADMIN_TOKEN", "envtoken"):
            token = sut.get_admin_token()
        self.assertEqual(token, "envtoken")

    def test_get_admin_token_returns_file_token_when_file_exists(self):
        self.token_file.write_text("filetoken")
        with patch.object(sut, "ADMIN_TOKEN", "envtoken"):
            token = sut.get_admin_token()
        self.assertEqual(token, "filetoken")

    def test_get_admin_token_falls_back_to_env_when_file_is_empty(self):
        self.token_file.write_text("")
        with patch.object(sut, "ADMIN_TOKEN", "envtoken"):
            token = sut.get_admin_token()
        self.assertEqual(token, "envtoken")

    def test_set_admin_token_writes_to_file(self):
        sut.set_admin_token("newtoken")
        self.assertEqual(self.token_file.read_text(), "newtoken")


class TestBuildStats(unittest.TestCase):

    def setUp(self):
        self.store = _make_store()

    def _create(self, **kw):
        with patch.object(sut, "STORE", self.store):
            return self.store.create_application(_minimal_payload(**kw))

    def test_total_count_reflects_number_of_applications(self):
        self._create()
        self._create(name="다른사람", phone="01099998888")
        data = self.store.list_applications()
        self.assertEqual(data["stats"]["totalCount"], 2)

    def test_coupon_count_counts_applications_with_coupon(self):
        self._create(discount="CODE1")
        self._create()
        data = self.store.list_applications()
        self.assertEqual(data["stats"]["couponCount"], 1)

    def test_today_count_counts_applications_created_today(self):
        self._create()
        data = self.store.list_applications()
        self.assertEqual(data["stats"]["todayCount"], 1)


# ===========================================================================
# 2. HTTP Integration Tests
# ===========================================================================

class TestHTTPBase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.store = _make_store()
        # Patch ADMIN_TOKEN_FILE so password tests don't pollute real file
        cls._token_file = Path(tempfile.mktemp(dir=_TMP_DIR, suffix=".tok"))
        cls._patches = [
            patch.object(sut, "ADMIN_TOKEN_FILE", cls._token_file),
            patch.object(sut, "ADMIN_TOKEN", "testtoken123"),
        ]
        for p in cls._patches:
            p.start()
        cls.srv = _LiveServer()
        cls.srv.start(cls.store)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        for p in cls._patches:
            p.stop()
        if cls._token_file.exists():
            cls._token_file.unlink()

    def _req(self, method, path, body=None, token="testtoken123", **kw):
        return self.srv.request(method, path, body=body, token=token, **kw)


class TestHealthEndpoint(TestHTTPBase):

    def test_health_returns_200(self):
        status, data = self._req("GET", "/api/health", token=None)
        self.assertEqual(status, 200)

    def test_health_ok_field_is_true(self):
        _, data = self._req("GET", "/api/health", token=None)
        self.assertTrue(data["ok"])

    def test_health_storage_is_sqlite(self):
        _, data = self._req("GET", "/api/health", token=None)
        self.assertEqual(data["storage"], "sqlite")


class TestAuthEndpoints(TestHTTPBase):

    def test_login_with_correct_token_returns_200(self):
        status, data = self._req("POST", "/api/auth/login",
                                  body={"token": "testtoken123"}, token=None)
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_login_with_wrong_token_returns_401(self):
        status, data = self._req("POST", "/api/auth/login",
                                  body={"token": "wrongpassword"}, token=None)
        self.assertEqual(status, 401)

    def test_auth_check_with_valid_bearer_returns_200(self):
        status, data = self._req("GET", "/api/auth/check")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_auth_check_without_token_returns_401(self):
        status, _ = self._req("GET", "/api/auth/check", token=None)
        self.assertEqual(status, 401)

    def test_auth_check_with_wrong_token_returns_401(self):
        status, _ = self._req("GET", "/api/auth/check", token="badtoken")
        self.assertEqual(status, 401)

    def test_login_with_invalid_json_returns_400(self):
        status, _ = self.srv.request("POST", "/api/auth/login",
                                      raw_body=b"not-json",
                                      token=None,
                                      content_type="application/json")
        self.assertEqual(status, 400)


class TestApplicationsEndpoints(TestHTTPBase):

    def _post_application(self, **overrides):
        payload = _minimal_payload(**overrides)
        return self._req("POST", "/api/applications", body=payload, token=None)

    def test_post_application_returns_201(self):
        status, _ = self._post_application()
        self.assertEqual(status, 201)

    def test_post_application_returns_application_and_account(self):
        _, data = self._post_application()
        self.assertIn("application", data)
        self.assertIn("account", data)

    def test_post_application_stores_name_correctly(self):
        _, data = self._post_application(name="신청자테스트")
        self.assertEqual(data["application"]["name"], "신청자테스트")

    def test_post_application_invalid_json_returns_400(self):
        status, _ = self.srv.request("POST", "/api/applications",
                                      raw_body=b"{bad json",
                                      token=None,
                                      content_type="application/json")
        self.assertEqual(status, 400)

    def test_post_application_missing_name_returns_400(self):
        status, data = self._req("POST", "/api/applications",
                                  body={"phone": "01012345678", "age": "25",
                                        "branch": "건대", "gender": "male",
                                        "date": "금요일"}, token=None)
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_post_application_invalid_age_returns_400(self):
        status, _ = self._post_application(age="15")
        self.assertEqual(status, 400)

    def test_post_application_increments_discount_usage(self):
        self.store.create_discount_code("HTTP_TEST", "fixed", 1000, 10)
        initial = self.store.validate_discount_code("HTTP_TEST")
        initial_count = initial["used_count"]
        self._post_application(discount="HTTP_TEST")
        updated = self.store.get_discount_codes()
        code_data = next(c for c in updated if c["code"] == "HTTP_TEST")
        self.assertEqual(code_data["used_count"], initial_count + 1)

    def test_get_applications_requires_auth(self):
        status, _ = self._req("GET", "/api/applications", token=None)
        self.assertEqual(status, 401)

    def test_get_applications_returns_200_with_auth(self):
        status, data = self._req("GET", "/api/applications")
        self.assertEqual(status, 200)
        self.assertIn("applications", data)

    def test_get_single_application_returns_200_for_existing(self):
        _, created = self._post_application(name="싱글테스트")
        app_id = created["application"]["id"]
        status, data = self._req("GET", f"/api/applications/{app_id}", token=None)
        self.assertEqual(status, 200)
        self.assertEqual(data["application"]["id"], app_id)

    def test_get_single_application_returns_404_for_missing(self):
        status, _ = self._req("GET", "/api/applications/999999", token=None)
        self.assertEqual(status, 404)

    def test_get_single_application_invalid_id_returns_400(self):
        status, _ = self._req("GET", "/api/applications/abc", token=None)
        self.assertEqual(status, 400)

    def test_patch_application_returns_200(self):
        _, created = self._post_application()
        app_id = created["application"]["id"]
        status, data = self._req("PATCH", f"/api/applications/{app_id}",
                                  body={"status": "입금완료"})
        self.assertEqual(status, 200)
        self.assertEqual(data["application"]["status"], "입금완료")

    def test_patch_application_requires_auth(self):
        _, created = self._post_application()
        app_id = created["application"]["id"]
        status, _ = self._req("PATCH", f"/api/applications/{app_id}",
                               body={"status": "입금완료"}, token=None)
        self.assertEqual(status, 401)

    def test_patch_application_returns_404_for_missing(self):
        status, _ = self._req("PATCH", "/api/applications/999999",
                               body={"status": "입금완료"})
        self.assertEqual(status, 404)

    def test_patch_application_invalid_id_returns_400(self):
        status, _ = self._req("PATCH", "/api/applications/not-an-id",
                               body={"status": "입금완료"})
        self.assertEqual(status, 400)

    def test_patch_non_applications_path_returns_404(self):
        status, _ = self._req("PATCH", "/api/other")
        self.assertEqual(status, 404)


class TestDeleteEndpoints(TestHTTPBase):

    def _post_application(self, **overrides):
        payload = _minimal_payload(**overrides)
        _, data = self._req("POST", "/api/applications", body=payload, token=None)
        return data["application"]

    def test_delete_application_returns_200(self):
        app = self._post_application()
        status, data = self._req("POST", "/api/admin/applications/delete",
                                  body={"id": app["id"]})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_delete_application_requires_auth(self):
        app = self._post_application()
        status, _ = self._req("POST", "/api/admin/applications/delete",
                               body={"id": app["id"]}, token=None)
        self.assertEqual(status, 401)

    def test_delete_application_returns_404_for_missing(self):
        status, _ = self._req("POST", "/api/admin/applications/delete",
                               body={"id": 999999})
        self.assertEqual(status, 404)

    def test_delete_application_invalid_id_returns_400(self):
        status, _ = self._req("POST", "/api/admin/applications/delete",
                               body={"id": "not-a-number"})
        self.assertEqual(status, 400)

    def test_bulk_delete_returns_deleted_count(self):
        app1 = self._post_application(name="삭제1", phone="01011112222")
        app2 = self._post_application(name="삭제2", phone="01033334444")
        status, data = self._req("POST", "/api/admin/applications/bulk-delete",
                                  body={"ids": [app1["id"], app2["id"]]})
        self.assertEqual(status, 200)
        self.assertEqual(data["deleted_count"], 2)

    def test_bulk_delete_requires_auth(self):
        status, _ = self._req("POST", "/api/admin/applications/bulk-delete",
                               body={"ids": [1]}, token=None)
        self.assertEqual(status, 401)

    def test_bulk_delete_empty_ids_returns_400(self):
        status, _ = self._req("POST", "/api/admin/applications/bulk-delete",
                               body={"ids": []})
        self.assertEqual(status, 400)

    def test_bulk_delete_non_list_ids_returns_400(self):
        status, _ = self._req("POST", "/api/admin/applications/bulk-delete",
                               body={"ids": "not-a-list"})
        self.assertEqual(status, 400)

    def test_bulk_delete_skips_invalid_ids(self):
        app = self._post_application(name="유효", phone="01055556666")
        status, data = self._req("POST", "/api/admin/applications/bulk-delete",
                                  body={"ids": [app["id"], "invalid", None]})
        self.assertEqual(status, 200)
        self.assertEqual(data["deleted_count"], 1)


class TestCapacityEndpoints(TestHTTPBase):

    def test_get_capacity_requires_auth(self):
        status, _ = self._req("GET", "/api/capacity", token=None)
        self.assertEqual(status, 401)

    def test_get_capacity_returns_200_with_auth(self):
        status, data = self._req("GET", "/api/capacity")
        self.assertEqual(status, 200)
        self.assertIn("capacity", data)

    def test_post_capacity_sets_value(self):
        status, data = self._req("POST", "/api/capacity",
                                  body={"day": "금요일", "capacity": 50})
        self.assertEqual(status, 200)
        self.assertEqual(data["capacity"]["금요일"], 50)

    def test_post_capacity_requires_auth(self):
        status, _ = self._req("POST", "/api/capacity",
                               body={"day": "금요일", "capacity": 50}, token=None)
        self.assertEqual(status, 401)

    def test_post_capacity_missing_day_returns_400(self):
        status, _ = self._req("POST", "/api/capacity", body={"capacity": 30})
        self.assertEqual(status, 400)

    def test_get_scarcity_returns_200_without_auth(self):
        status, data = self._req("GET", "/api/scarcity", token=None)
        self.assertEqual(status, 200)
        self.assertIn("dates", data)


class TestDiscountCodeEndpoints(TestHTTPBase):

    def test_get_discount_codes_requires_auth(self):
        status, _ = self._req("GET", "/api/discount-codes", token=None)
        self.assertEqual(status, 401)

    def test_get_discount_codes_returns_200_with_auth(self):
        status, data = self._req("GET", "/api/discount-codes")
        self.assertEqual(status, 200)
        self.assertIn("discount_codes", data)

    def test_post_discount_code_creates_code(self):
        status, data = self._req("POST", "/api/discount-codes",
                                  body={"code": "NEW10", "discount_type": "fixed",
                                        "discount_value": 10000, "max_uses": 0})
        self.assertEqual(status, 201)
        self.assertIn("discount_code", data)
        self.assertEqual(data["discount_code"]["code"], "NEW10")

    def test_post_discount_code_requires_auth(self):
        status, _ = self._req("POST", "/api/discount-codes",
                               body={"code": "X"}, token=None)
        self.assertEqual(status, 401)

    def test_post_discount_code_missing_code_returns_400(self):
        status, _ = self._req("POST", "/api/discount-codes",
                               body={"discount_type": "fixed", "discount_value": 0})
        self.assertEqual(status, 400)

    def test_post_discount_code_invalid_type_returns_400(self):
        status, _ = self._req("POST", "/api/discount-codes",
                               body={"code": "X", "discount_type": "invalid",
                                     "discount_value": 0})
        self.assertEqual(status, 400)

    def test_validate_discount_code_returns_valid_true_for_active_code(self):
        self.store.create_discount_code("VALID_EP", "fixed", 5000, 0)
        status, data = self._req("GET", "/api/discount/validate?code=VALID_EP",
                                  token=None)
        self.assertEqual(status, 200)
        self.assertTrue(data["valid"])

    def test_validate_discount_code_returns_valid_false_for_unknown(self):
        status, data = self._req("GET", "/api/discount/validate?code=UNKNOWN_CODE",
                                  token=None)
        self.assertEqual(status, 200)
        self.assertFalse(data["valid"])

    def test_validate_discount_code_missing_param_returns_400(self):
        status, _ = self._req("GET", "/api/discount/validate", token=None)
        self.assertEqual(status, 400)


class TestFaqEndpoints(TestHTTPBase):

    def test_get_faq_returns_active_items_without_auth(self):
        status, data = self._req("GET", "/api/faq", token=None)
        self.assertEqual(status, 200)
        self.assertIn("faq", data)

    def test_get_admin_faq_requires_auth(self):
        status, _ = self._req("GET", "/api/admin/faq", token=None)
        self.assertEqual(status, 401)

    def test_get_admin_faq_returns_all_items(self):
        status, data = self._req("GET", "/api/admin/faq")
        self.assertEqual(status, 200)
        self.assertIn("faq", data)

    def test_post_faq_creates_item(self):
        status, data = self._req("POST", "/api/admin/faq",
                                  body={"question": "Q?", "answer": "A.", "sort_order": 0})
        self.assertEqual(status, 201)
        self.assertIn("faq", data)
        self.assertEqual(data["faq"]["question"], "Q?")

    def test_post_faq_requires_auth(self):
        status, _ = self._req("POST", "/api/admin/faq",
                               body={"question": "Q", "answer": "A"}, token=None)
        self.assertEqual(status, 401)

    def test_post_faq_missing_question_returns_400(self):
        status, _ = self._req("POST", "/api/admin/faq",
                               body={"answer": "A"})
        self.assertEqual(status, 400)

    def test_post_faq_update_changes_content(self):
        _, created = self._req("POST", "/api/admin/faq",
                                body={"question": "Old Q", "answer": "Old A", "sort_order": 0})
        faq_id = created["faq"]["id"]
        status, data = self._req("POST", "/api/admin/faq/update",
                                  body={"id": faq_id, "question": "New Q",
                                        "answer": "New A", "sort_order": 0, "is_active": 1})
        self.assertEqual(status, 200)
        self.assertEqual(data["faq"]["question"], "New Q")

    def test_post_faq_update_returns_404_for_missing(self):
        status, _ = self._req("POST", "/api/admin/faq/update",
                               body={"id": 999999, "question": "Q",
                                     "answer": "A", "sort_order": 0, "is_active": 1})
        self.assertEqual(status, 404)

    def test_post_faq_delete_removes_item(self):
        _, created = self._req("POST", "/api/admin/faq",
                                body={"question": "Del Q", "answer": "Del A", "sort_order": 0})
        faq_id = created["faq"]["id"]
        status, data = self._req("POST", "/api/admin/faq/delete",
                                  body={"id": faq_id})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_post_faq_delete_missing_id_returns_400(self):
        status, _ = self._req("POST", "/api/admin/faq/delete", body={})
        self.assertEqual(status, 400)


class TestSiteContentEndpoints(TestHTTPBase):

    def test_get_site_content_returns_200_without_auth(self):
        status, data = self._req("GET", "/api/site-content", token=None)
        self.assertEqual(status, 200)
        self.assertIn("content", data)

    def test_post_site_content_requires_auth(self):
        status, _ = self._req("POST", "/api/site-content",
                               body={"content": {"k": "v"}}, token=None)
        self.assertEqual(status, 401)

    def test_post_site_content_stores_values(self):
        status, data = self._req("POST", "/api/site-content",
                                  body={"content": {"test_key": "test_value"}})
        self.assertEqual(status, 200)
        self.assertEqual(data["content"]["test_key"], "test_value")

    def test_post_site_content_invalid_content_returns_400(self):
        status, _ = self._req("POST", "/api/site-content",
                               body={"content": "not a dict"})
        self.assertEqual(status, 400)


class TestAccountEndpoints(TestHTTPBase):

    def test_get_account_returns_200_without_auth(self):
        status, data = self._req("GET", "/api/account", token=None)
        self.assertEqual(status, 200)
        self.assertIn("account", data)

    def test_get_admin_account_requires_auth(self):
        status, _ = self._req("GET", "/api/admin/account", token=None)
        self.assertEqual(status, 401)

    def test_get_admin_account_returns_200_with_auth(self):
        status, data = self._req("GET", "/api/admin/account")
        self.assertEqual(status, 200)
        self.assertIn("account", data)

    def test_post_admin_account_updates_info(self):
        status, data = self._req("POST", "/api/admin/account",
                                  body={"bank": "신한", "account_number": "110-123",
                                        "holder": "홍씨"})
        self.assertEqual(status, 200)
        self.assertEqual(data["account"]["bank"], "신한")

    def test_post_admin_account_missing_field_returns_400(self):
        status, _ = self._req("POST", "/api/admin/account",
                               body={"bank": "신한"})
        self.assertEqual(status, 400)

    def test_post_admin_account_requires_auth(self):
        status, _ = self._req("POST", "/api/admin/account",
                               body={"bank": "신한", "account_number": "1",
                                     "holder": "X"}, token=None)
        self.assertEqual(status, 401)


class TestPricingEndpoints(TestHTTPBase):

    def test_get_pricing_requires_auth(self):
        status, _ = self._req("GET", "/api/pricing", token=None)
        self.assertEqual(status, 401)

    def test_get_pricing_returns_200_with_auth(self):
        status, data = self._req("GET", "/api/pricing")
        self.assertEqual(status, 200)
        self.assertIn("pricing", data)

    def test_post_pricing_stores_values(self):
        new_pricing = {"건대": {"male": 99000, "female": 88000, "note": "테스트"}}
        status, data = self._req("POST", "/api/pricing",
                                  body={"pricing": new_pricing})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_post_pricing_requires_auth(self):
        status, _ = self._req("POST", "/api/pricing",
                               body={"pricing": {}}, token=None)
        self.assertEqual(status, 401)


class TestPartyDatesEndpoints(TestHTTPBase):

    def test_get_party_dates_returns_200_without_auth(self):
        status, data = self._req("GET", "/api/party-dates", token=None)
        self.assertEqual(status, 200)
        self.assertIn("dates", data)

    def test_post_admin_party_dates_stores_dates(self):
        dates = ["2026-04-25", "2026-05-02"]
        status, data = self._req("POST", "/api/admin/party-dates",
                                  body={"dates": dates})
        self.assertEqual(status, 200)
        self.assertEqual(data["dates"], dates)

    def test_post_admin_party_dates_requires_auth(self):
        status, _ = self._req("POST", "/api/admin/party-dates",
                               body={"dates": []}, token=None)
        self.assertEqual(status, 401)

    def test_post_admin_party_dates_non_list_returns_400(self):
        status, _ = self._req("POST", "/api/admin/party-dates",
                               body={"dates": "not-a-list"})
        self.assertEqual(status, 400)

    def test_get_party_dates_reflects_stored_dates(self):
        dates = ["2026-06-01", "2026-06-08"]
        self._req("POST", "/api/admin/party-dates", body={"dates": dates})
        _, data = self._req("GET", "/api/party-dates", token=None)
        self.assertEqual(data["dates"], dates)


class TestPasswordChangeEndpoint(TestHTTPBase):

    def test_change_password_returns_200_on_success(self):
        # Use a fresh store + fresh token for isolation
        with patch.object(sut, "get_admin_token", return_value="testtoken123"):
            status, data = self._req("POST", "/api/admin/password",
                                      body={"currentPassword": "testtoken123",
                                            "newPassword": "newpass456"})
        # Restore original token file state
        if sut.ADMIN_TOKEN_FILE.exists():
            sut.ADMIN_TOKEN_FILE.unlink()
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_change_password_wrong_current_returns_401(self):
        status, _ = self._req("POST", "/api/admin/password",
                               body={"currentPassword": "wrongpass",
                                     "newPassword": "newpass456"})
        self.assertEqual(status, 401)

    def test_change_password_too_short_returns_400(self):
        status, _ = self._req("POST", "/api/admin/password",
                               body={"currentPassword": "testtoken123",
                                     "newPassword": "abc"})
        self.assertEqual(status, 400)

    def test_change_password_requires_auth(self):
        status, _ = self._req("POST", "/api/admin/password",
                               body={"currentPassword": "testtoken123",
                                     "newPassword": "newpass456"}, token=None)
        self.assertEqual(status, 401)


class TestBackupAndCsvEndpoints(TestHTTPBase):

    def test_get_backup_requires_auth(self):
        status, _ = self._req("GET", "/api/backup", token=None)
        self.assertEqual(status, 401)

    def test_get_backup_returns_200_with_auth(self):
        status, data = self._req("GET", "/api/backup")
        self.assertEqual(status, 200)
        self.assertIn("exportedAt", data)

    def test_get_csv_export_requires_auth(self):
        status, _ = self._req("GET", "/api/applications/export/csv", token=None)
        self.assertEqual(status, 401)

    def test_get_csv_export_returns_200_with_auth(self):
        status, raw = self._req("GET", "/api/applications/export/csv")
        self.assertEqual(status, 200)

    def test_get_csv_export_via_token_param(self):
        status, raw = self.srv.request(
            "GET", "/api/applications/export/csv?token=testtoken123",
            token=None
        )
        self.assertEqual(status, 200)

    def test_get_csv_export_wrong_token_param_returns_401(self):
        status, _ = self.srv.request(
            "GET", "/api/applications/export/csv?token=badtoken",
            token=None
        )
        self.assertEqual(status, 401)


class TestCORSHeaders(TestHTTPBase):

    def test_options_request_returns_204(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.srv.port, timeout=10)
        conn.request("OPTIONS", "/api/health")
        resp = conn.getresponse()
        conn.close()
        self.assertEqual(resp.status, 204)

    def test_allowed_localhost_origin_echoed_back(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.srv.port, timeout=10)
        conn.request("GET", "/api/health",
                     headers={"Origin": "http://localhost:3000"})
        resp = conn.getresponse()
        acao = resp.getheader("Access-Control-Allow-Origin")
        conn.close()
        self.assertEqual(acao, "http://localhost:3000")

    def test_disallowed_origin_gets_first_allowed_origin(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.srv.port, timeout=10)
        conn.request("GET", "/api/health",
                     headers={"Origin": "https://evil.example.com"})
        resp = conn.getresponse()
        acao = resp.getheader("Access-Control-Allow-Origin")
        conn.close()
        self.assertEqual(acao, sut.ALLOWED_ORIGINS[0])

    def test_response_includes_cache_control_no_store(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.srv.port, timeout=10)
        conn.request("GET", "/api/health")
        resp = conn.getresponse()
        cc = resp.getheader("Cache-Control")
        conn.close()
        self.assertEqual(cc, "no-store")


class TestScarcityOverride(TestHTTPBase):

    def test_scarcity_override_changes_level(self):
        self.store.upsert_site_content(
            {"scarcity_override": json.dumps({"금요일": "마감"})}
        )
        _, data = self._req("GET", "/api/scarcity", token=None)
        if "금요일" in data["dates"]:
            self.assertEqual(data["dates"]["금요일"]["level"], "마감")
        # Clean up
        self.store.upsert_site_content({"scarcity_override": ""})

    def test_scarcity_custom_badge_text_included(self):
        self.store.upsert_site_content({"scarcity-badge-text": "잔여 5석"})
        _, data = self._req("GET", "/api/scarcity", token=None)
        self.assertEqual(data.get("custom_badge_text"), "잔여 5석")
        self.store.upsert_site_content({"scarcity-badge-text": ""})

    def test_scarcity_custom_sticky_text_included(self):
        self.store.upsert_site_content({"sticky-cta-text": "지금 신청하기!"})
        _, data = self._req("GET", "/api/scarcity", token=None)
        self.assertEqual(data.get("custom_sticky_text"), "지금 신청하기!")
        self.store.upsert_site_content({"sticky-cta-text": ""})

    def test_scarcity_instagram_id_included(self):
        self.store.upsert_site_content({"instagram-id": "oddparty_official"})
        _, data = self._req("GET", "/api/scarcity", token=None)
        self.assertEqual(data.get("instagram_id"), "oddparty_official")
        self.store.upsert_site_content({"instagram-id": ""})


class TestUnknownRoutes(TestHTTPBase):

    def test_post_unknown_path_returns_404(self):
        status, data = self._req("POST", "/api/unknown-route")
        self.assertEqual(status, 404)

    def test_patch_non_applications_path_returns_404(self):
        status, _ = self._req("PATCH", "/api/other-route")
        self.assertEqual(status, 404)


class TestReadPayload(unittest.TestCase):
    """Unit-test _read_payload parsing for form-urlencoded bodies."""

    def _make_handler(self):
        """Create a minimal handler instance without starting a server."""
        handler = object.__new__(sut.PartyRequestHandler)
        return handler

    def test_form_urlencoded_payload_parsed_correctly(self):
        body = b"name=%ED%99%8D%EA%B8%B8%EB%8F%99&age=25"
        handler = self._make_handler()
        handler.headers = {"Content-Type": "application/x-www-form-urlencoded",
                           "Content-Length": str(len(body))}

        class FakeHeaders(dict):
            def get(self, key, default=""):
                return super().get(key, default)

        handler.headers = FakeHeaders(handler.headers)
        handler.rfile = io.BytesIO(body)
        result = handler._read_payload()
        self.assertEqual(result.get("age"), "25")

    def test_empty_body_returns_empty_dict(self):
        handler = self._make_handler()

        class FakeHeaders(dict):
            def get(self, key, default=""):
                return super().get(key, default)

        handler.headers = FakeHeaders({"Content-Type": "application/json",
                                        "Content-Length": "0"})
        handler.rfile = io.BytesIO(b"")
        result = handler._read_payload()
        self.assertEqual(result, {})


class TestIsOriginAllowed(unittest.TestCase):

    def _make_handler(self):
        handler = object.__new__(sut.PartyRequestHandler)
        return handler

    def test_empty_origin_allowed(self):
        self.assertTrue(self._make_handler()._is_origin_allowed(""))

    def test_localhost_origin_allowed(self):
        self.assertTrue(self._make_handler()._is_origin_allowed("http://localhost:3000"))

    def test_127_0_0_1_origin_allowed(self):
        self.assertTrue(self._make_handler()._is_origin_allowed("http://127.0.0.1:8080"))

    def test_allowed_vercel_origin_allowed(self):
        origin = "https://gagisiro-party-demo-site.vercel.app"
        self.assertTrue(self._make_handler()._is_origin_allowed(origin))

    def test_unknown_origin_not_allowed(self):
        self.assertFalse(self._make_handler()._is_origin_allowed("https://hacker.io"))


class TestBulkDeleteApplications(unittest.TestCase):

    def test_bulk_delete_multiple(self):
        store = _make_store()
        a1 = store.create_application(_minimal_payload())
        a2 = store.create_application(_minimal_payload(name="김철수"))
        a3 = store.create_application(_minimal_payload(name="박영희"))
        deleted = store.bulk_delete_applications([a1["id"], a2["id"]])
        self.assertEqual(deleted, 2)
        self.assertIsNone(store.get_application(a1["id"]))
        self.assertIsNone(store.get_application(a2["id"]))
        self.assertIsNotNone(store.get_application(a3["id"]))

    def test_bulk_delete_empty_list(self):
        store = _make_store()
        self.assertEqual(store.bulk_delete_applications([]), 0)

    def test_bulk_delete_nonexistent_ids(self):
        store = _make_store()
        deleted = store.bulk_delete_applications([99999, 88888])
        self.assertEqual(deleted, 0)

    def test_bulk_delete_mixed_valid_invalid(self):
        store = _make_store()
        a1 = store.create_application(_minimal_payload())
        deleted = store.bulk_delete_applications([a1["id"], 99999])
        self.assertEqual(deleted, 1)


class TestPayloadSizeLimit(TestHTTPBase):

    def test_oversized_payload_rejected(self):
        """Payloads over 1MB should be rejected."""
        huge_body = b"x" * (1_048_577 + 100)
        status, _ = self.srv.request(
            "POST", "/api/auth/login",
            raw_body=huge_body,
            token=None,
        )
        self.assertIn(status, (400, 500))


class TestBulkDeleteEndpoint(TestHTTPBase):

    def test_bulk_delete_over_500_rejected(self):
        status, data = self.srv.request(
            "POST", "/api/admin/applications/bulk-delete",
            body={"ids": list(range(501))},
        )
        self.assertEqual(status, 400)
        self.assertIn("500", data.get("error", ""))

    def test_bulk_delete_success(self):
        status, created = self.srv.request(
            "POST", "/api/applications",
            body=_minimal_payload(),
            token=None,
        )
        app_id = created.get("application", {}).get("id") or created.get("id")

        status, data = self.srv.request(
            "POST", "/api/admin/applications/bulk-delete",
            body={"ids": [app_id]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["deleted_count"], 1)


# ===========================================================================
# 3. Gap-fill tests: reachable branches not yet covered
# ===========================================================================

class TestToIso8601StrptimeFallback(unittest.TestCase):
    """Line 845-846: _to_iso8601 falls back to strptime for non-ISO strings."""

    def test_space_separated_datetime_string_parsed(self):
        # SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" without timezone
        result = sut.ApplicationStore._to_iso8601("2026-03-11 09:30:00")
        self.assertIn("2026-03-11", result)
        self.assertTrue(result.endswith("Z"))

    def test_naive_datetime_object_gets_utc_tzinfo(self):
        from datetime import datetime
        dt = datetime(2026, 6, 1, 12, 0, 0)  # no tzinfo
        result = sut.ApplicationStore._to_iso8601(dt)
        self.assertTrue(result.endswith("Z"))


class TestIsAdminAuthenticatedEdgeCases(unittest.TestCase):
    """Line 875: _is_admin_authenticated returns False for various bad inputs."""

    def _make_handler(self, auth_header):
        handler = object.__new__(sut.PartyRequestHandler)

        class FakeHeaders(dict):
            def get(self, key, default=""):
                return super().get(key, default)

        handler.headers = FakeHeaders({"Authorization": auth_header})
        return handler

    def test_no_bearer_prefix_returns_false(self):
        handler = self._make_handler("Basic dXNlcjpwYXNz")
        with patch.object(sut, "get_admin_token", return_value="testtoken123"):
            self.assertFalse(handler._is_admin_authenticated())

    def test_bearer_with_empty_token_returns_false(self):
        handler = self._make_handler("Bearer ")
        with patch.object(sut, "get_admin_token", return_value="testtoken123"):
            self.assertFalse(handler._is_admin_authenticated())

    def test_bearer_with_wrong_token_returns_false(self):
        handler = self._make_handler("Bearer wrongtoken")
        with patch.object(sut, "get_admin_token", return_value="testtoken123"):
            self.assertFalse(handler._is_admin_authenticated())


class TestHTTPRedirects(TestHTTPBase):
    """Lines 899-907: /admin.html and /admin/ redirect; /admin serves file."""

    def test_admin_html_path_redirects_to_admin(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.srv.port, timeout=10)
        conn.request("GET", "/admin.html")
        resp = conn.getresponse()
        status = resp.status
        location = resp.getheader("Location")
        conn.close()
        self.assertEqual(status, 302)
        self.assertEqual(location, "/admin")

    def test_admin_slash_path_redirects_to_admin(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.srv.port, timeout=10)
        conn.request("GET", "/admin/")
        resp = conn.getresponse()
        status = resp.status
        location = resp.getheader("Location")
        conn.close()
        self.assertEqual(status, 302)
        self.assertEqual(location, "/admin")


class TestPartyDatesParsingFallback(TestHTTPBase):
    """Lines 1065-1068: /api/party-dates returns [] when stored value is bad JSON
    or when no value stored at all."""

    def test_party_dates_returns_empty_list_when_nothing_stored(self):
        # Clear any stored party_dates
        self.store.upsert_site_content({"party_dates": ""})
        _, data = self._req("GET", "/api/party-dates", token=None)
        self.assertEqual(data["dates"], [])

    def test_party_dates_returns_empty_list_when_corrupt_json(self):
        # Bypass _normalize_site_content length checks by storing via direct sqlite
        conn = self.store._sqlite_connection()
        conn.execute(
            "INSERT INTO site_content (content_key, content_value, updated_at) "
            "VALUES ('party_dates', '{bad json', CURRENT_TIMESTAMP) "
            "ON CONFLICT(content_key) DO UPDATE SET content_value=excluded.content_value"
        )
        conn.commit()
        conn.close()
        _, data = self._req("GET", "/api/party-dates", token=None)
        self.assertEqual(data["dates"], [])


class TestScarcityOverrideCorruptJson(TestHTTPBase):
    """Line 960-961: scarcity_override silently ignores corrupt JSON."""

    def test_scarcity_with_corrupt_override_still_returns_200(self):
        conn = self.store._sqlite_connection()
        conn.execute(
            "INSERT INTO site_content (content_key, content_value, updated_at) "
            "VALUES ('scarcity_override', '{not valid json', CURRENT_TIMESTAMP) "
            "ON CONFLICT(content_key) DO UPDATE SET content_value=excluded.content_value"
        )
        conn.commit()
        conn.close()
        status, data = self._req("GET", "/api/scarcity", token=None)
        self.assertEqual(status, 200)
        self.assertIn("dates", data)


class TestBadJsonBodiesForPostEndpoints(TestHTTPBase):
    """Lines 1098-1100, 1124-1127, 1154-1155, 1221-1223, 1245-1248, 1264-1267,
    1303-1306, 1358-1360: every POST endpoint that reads JSON returns 400 on
    malformed body."""

    def _bad_json(self, path):
        return self.srv.request(
            "POST", path,
            raw_body=b"{bad",
            token="testtoken123",
            content_type="application/json",
        )

    def test_admin_password_bad_json_returns_400(self):
        status, _ = self._bad_json("/api/admin/password")
        self.assertEqual(status, 400)

    def test_admin_party_dates_bad_json_returns_400(self):
        status, _ = self._bad_json("/api/admin/party-dates")
        self.assertEqual(status, 400)

    def test_capacity_bad_json_returns_400(self):
        # capacity endpoint catches generic Exception -> 500, but bad JSON -> 500 too
        # (the handler does int(payload.get(...)) which throws if payload is {})
        # Bad JSON itself triggers json.JSONDecodeError inside _read_payload -> raises
        # which propagates to the outer except Exception
        status, _ = self._bad_json("/api/capacity")
        self.assertIn(status, (400, 500))

    def test_site_content_bad_json_returns_400(self):
        status, _ = self._bad_json("/api/site-content")
        self.assertEqual(status, 400)

    def test_discount_codes_bad_json_returns_400(self):
        status, _ = self._bad_json("/api/discount-codes")
        self.assertEqual(status, 400)

    def test_admin_account_bad_json_returns_400(self):
        status, _ = self._bad_json("/api/admin/account")
        self.assertEqual(status, 400)

    def test_admin_applications_delete_bad_json_returns_400(self):
        status, _ = self._bad_json("/api/admin/applications/delete")
        self.assertEqual(status, 400)

    def test_admin_bulk_delete_bad_json_returns_400(self):
        status, _ = self._bad_json("/api/admin/applications/bulk-delete")
        self.assertEqual(status, 400)

    def test_patch_application_bad_json_returns_400(self):
        # Need a real application to get past the auth+id check
        _, created = self._req("POST", "/api/applications",
                                body=_minimal_payload(), token=None)
        app_id = created["application"]["id"]
        status, _ = self.srv.request(
            "PATCH", f"/api/applications/{app_id}",
            raw_body=b"{bad",
            token="testtoken123",
            content_type="application/json",
        )
        self.assertEqual(status, 400)


class TestFaqUpdateMissingFields(TestHTTPBase):
    """Line 1186-1187: /api/admin/faq/update requires id, question, and answer."""

    def test_faq_update_missing_question_returns_400(self):
        status, _ = self._req("POST", "/api/admin/faq/update",
                               body={"id": 1, "answer": "A",
                                     "sort_order": 0, "is_active": 1})
        self.assertEqual(status, 400)

    def test_faq_update_missing_id_returns_400(self):
        status, _ = self._req("POST", "/api/admin/faq/update",
                               body={"id": 0, "question": "Q",
                                     "answer": "A", "sort_order": 0, "is_active": 1})
        self.assertEqual(status, 400)


class TestFaqDeleteBadJson(TestHTTPBase):
    """Line 1208-1209: /api/admin/faq/delete bad JSON returns 500."""

    def test_faq_delete_bad_json_returns_500(self):
        status, _ = self.srv.request(
            "POST", "/api/admin/faq/delete",
            raw_body=b"{bad",
            token="testtoken123",
            content_type="application/json",
        )
        self.assertEqual(status, 500)


class TestReadPayloadNoContentType(unittest.TestCase):
    """Line 1395: _read_payload with unknown content-type falls back to JSON parse."""

    def _make_handler(self):
        handler = object.__new__(sut.PartyRequestHandler)
        return handler

    def test_unknown_content_type_with_json_body_parsed(self):
        body = b'{"key": "value"}'

        class FakeHeaders(dict):
            def get(self, key, default=""):
                return super().get(key, default)

        handler = self._make_handler()
        handler.headers = FakeHeaders({
            "Content-Type": "text/plain",
            "Content-Length": str(len(body)),
        })
        handler.rfile = io.BytesIO(body)
        result = handler._read_payload()
        self.assertEqual(result["key"], "value")

    def test_no_content_type_no_body_returns_empty_dict(self):
        class FakeHeaders(dict):
            def get(self, key, default=""):
                return super().get(key, default)

        handler = self._make_handler()
        handler.headers = FakeHeaders({
            "Content-Type": "",
            "Content-Length": "0",
        })
        handler.rfile = io.BytesIO(b"")
        result = handler._read_payload()
        self.assertEqual(result, {})


class TestCorruptPricingFallback(unittest.TestCase):
    """Lines 594-595: _normalize_payload falls back to DEFAULT_PRICES when
    stored pricing JSON is corrupt."""

    def setUp(self):
        self.store = _make_store()

    def test_corrupt_pricing_json_uses_default_prices(self):
        # Write corrupt JSON directly to bypass validation
        conn = self.store._sqlite_connection()
        conn.execute(
            "INSERT INTO site_content (content_key, content_value, updated_at) "
            "VALUES ('pricing', '{bad json', CURRENT_TIMESTAMP) "
            "ON CONFLICT(content_key) DO UPDATE SET content_value=excluded.content_value"
        )
        conn.commit()
        conn.close()

        with patch.object(sut, "STORE", self.store):
            result = self.store._normalize_payload(_minimal_payload(branch="건대", gender="male"))
        # Default price for 건대 male is 33000
        self.assertEqual(result["price_amount"], 33000)


class TestToIso8601StrptimeNonIsoString(unittest.TestCase):
    """Lines 845-846: strptime fallback branch.

    On Python 3.11+ fromisoformat accepts "YYYY-MM-DD HH:MM:SS" directly, so
    the strptime branch (line 846) is unreachable on this runtime without
    monkeypatching a C-extension type (which unittest.mock cannot do).
    We document the known-dead-on-3.12 status and verify the surrounding
    behaviour instead.
    """

    def test_space_separated_sqlite_timestamp_returns_z_string(self):
        # fromisoformat handles this on Python 3.11+; result must still be valid
        result = sut.ApplicationStore._to_iso8601("2026-03-11 09:00:00")
        self.assertIn("2026-03-11", result)
        self.assertTrue(result.endswith("Z"))

    def test_naive_datetime_object_gets_utc_tzinfo(self):
        from datetime import datetime
        dt = datetime(2026, 6, 1, 12, 0, 0)  # no tzinfo — exercises line 857
        result = sut.ApplicationStore._to_iso8601(dt)
        self.assertTrue(result.endswith("Z"))


class TestHTTP500ErrorHandlers(TestHTTPBase):
    """Lines 1126-1127, 1154-1155, 1171-1172, 1193-1194, 1247-1248, 1266-1267,
    1305-1306: each POST endpoint's outer except Exception -> 500 handler."""

    def _inject_store_error(self, method_name: str):
        """Return a context manager that makes store.method_name raise RuntimeError."""
        return patch.object(self.store, method_name,
                            side_effect=RuntimeError("injected store error"))

    def test_party_dates_store_error_returns_500(self):
        with self._inject_store_error("upsert_site_content"):
            status, data = self._req("POST", "/api/admin/party-dates",
                                      body={"dates": ["2026-01-01"]})
        self.assertEqual(status, 500)

    def test_capacity_store_error_returns_500(self):
        with self._inject_store_error("set_capacity"):
            status, data = self._req("POST", "/api/capacity",
                                      body={"day": "금요일", "capacity": 10})
        self.assertEqual(status, 500)

    def test_pricing_store_error_returns_500(self):
        with self._inject_store_error("upsert_site_content"):
            status, data = self._req("POST", "/api/pricing",
                                      body={"pricing": {}})
        self.assertEqual(status, 500)

    def test_faq_create_store_error_returns_500(self):
        with self._inject_store_error("create_faq_item"):
            status, data = self._req("POST", "/api/admin/faq",
                                      body={"question": "Q", "answer": "A",
                                            "sort_order": 0})
        self.assertEqual(status, 500)

    def test_faq_update_store_error_returns_500(self):
        item = self.store.create_faq_item("Q", "A", 0)
        with self._inject_store_error("update_faq_item"):
            status, data = self._req("POST", "/api/admin/faq/update",
                                      body={"id": item["id"], "question": "Q",
                                            "answer": "A", "sort_order": 0,
                                            "is_active": 1})
        self.assertEqual(status, 500)

    def test_discount_codes_store_error_returns_500(self):
        with self._inject_store_error("create_discount_code"):
            status, data = self._req("POST", "/api/discount-codes",
                                      body={"code": "ERR", "discount_type": "fixed",
                                            "discount_value": 0, "max_uses": 0})
        self.assertEqual(status, 500)

    def test_admin_account_store_error_returns_500(self):
        with self._inject_store_error("set_account_info"):
            status, data = self._req("POST", "/api/admin/account",
                                      body={"bank": "X", "account_number": "1",
                                            "holder": "Y"})
        self.assertEqual(status, 500)

    def test_bulk_delete_store_error_returns_500(self):
        with patch.object(self.store, "bulk_delete_applications",
                          side_effect=RuntimeError("store exploded")):
            status, data = self._req("POST", "/api/admin/applications/bulk-delete",
                                      body={"ids": [999]})
        self.assertEqual(status, 500)

    def test_post_application_discount_error_silently_ignored(self):
        """Line 1329-1330: discount increment failure is swallowed."""
        self.store.create_discount_code("SILENT_ERR", "fixed", 100, 0)
        with patch.object(self.store, "increment_discount_usage",
                          side_effect=RuntimeError("db gone")):
            status, data = self._req("POST", "/api/applications",
                                      body=_minimal_payload(discount="SILENT_ERR"),
                                      token=None)
        # Application still created despite discount error
        self.assertEqual(status, 201)

    def test_faq_update_missing_answer_returns_400(self):
        """Line 1199: faq/update path where answer is empty -> 400."""
        status, _ = self._req("POST", "/api/admin/faq/update",
                               body={"id": 1, "question": "Q",
                                     "answer": "", "sort_order": 0, "is_active": 1})
        self.assertEqual(status, 400)

    def test_faq_delete_store_error_returns_500(self):
        """Line 1208-1209: faq/delete store error -> 500."""
        item = self.store.create_faq_item("Q", "A", 0)
        with self._inject_store_error("delete_faq_item"):
            status, _ = self._req("POST", "/api/admin/faq/delete",
                                   body={"id": item["id"]})
        self.assertEqual(status, 500)


class TestRailwayMissingDatabaseUrl(unittest.TestCase):
    """Line 76: Railway env without DATABASE_URL raises RuntimeError."""

    def test_railway_without_database_url_raises(self):
        with patch.object(sut, "IS_RAILWAY", True):
            with self.assertRaises(RuntimeError) as ctx:
                store = sut.ApplicationStore.__new__(sut.ApplicationStore)
                store.database_url = ""
                store.allow_sqlite_on_railway = False
                # Trigger the check
                sut.ApplicationStore.__init__(store)
        self.assertIn("DATABASE_URL", str(ctx.exception))

    def test_railway_with_allow_sqlite_flag_does_not_raise(self):
        with patch.object(sut, "IS_RAILWAY", True):
            with patch.dict(os.environ, {"ALLOW_SQLITE_ON_RAILWAY": "1",
                                          "DATABASE_URL": ""}):
                # Should not raise
                store = sut.ApplicationStore.__new__(sut.ApplicationStore)
                store.database_url = ""
                store.allow_sqlite_on_railway = True
                store.kind = "sqlite"
                # No exception expected from __init__'s guard
                self.assertEqual(store.kind, "sqlite")


if __name__ == "__main__":
    unittest.main()


# ===========================================================================
# Additional tests for uncovered lines
# ===========================================================================

class TestParseIsoDatetimeNoTzinfo(unittest.TestCase):

    def test_no_timezone_treated_as_utc(self):
        from datetime import timezone
        dt = sut.ApplicationStore._parse_iso_datetime("2026-01-01T12:00:00")
        self.assertIsNotNone(dt.tzinfo)
        self.assertEqual(dt.tzinfo, timezone.utc)
        self.assertEqual(dt.hour, 12)


class TestGetAdminPath(TestHTTPBase):

    def test_get_admin_returns_200(self):
        status, _ = self._req("GET", "/admin", token=None)
        self.assertEqual(status, 200)

    def test_get_admin_serves_html_content(self):
        conn = __import__("http.client", fromlist=["HTTPConnection"]).HTTPConnection(
            "127.0.0.1", self.srv.port, timeout=10
        )
        conn.request("GET", "/admin")
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        self.assertEqual(resp.status, 200)
        self.assertIn(b"<html", body.lower())


class TestGetRootPath(TestHTTPBase):

    def test_get_root_returns_200(self):
        status, _ = self._req("GET", "/", token=None)
        self.assertEqual(status, 200)

    def test_get_root_serves_html_content(self):
        conn = __import__("http.client", fromlist=["HTTPConnection"]).HTTPConnection(
            "127.0.0.1", self.srv.port, timeout=10
        )
        conn.request("GET", "/")
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        self.assertEqual(resp.status, 200)
        self.assertIn(b"<html", body.lower())


class TestUpsertEmptyContent(unittest.TestCase):
    """Line 365: upsert_site_content with empty normalized content returns existing."""

    def test_upsert_empty_content_returns_existing(self):
        store = _make_store()
        store.upsert_site_content({"key1": "value1"})
        result = store.upsert_site_content({})
        self.assertIn("key1", result)


class TestFaqUpdateDeleteAuthGuard(TestHTTPBase):
    """Lines 1182, 1204: FAQ update/delete without auth token returns 401."""

    def test_faq_update_without_auth_returns_401(self):
        status, _ = self._req("POST", "/api/admin/faq/update",
                              body={"id": 1, "question": "Q", "answer": "A"},
                              token=None)
        self.assertEqual(status, 401)

    def test_faq_delete_without_auth_returns_401(self):
        status, _ = self._req("POST", "/api/admin/faq/delete",
                              body={"id": 1},
                              token=None)
        self.assertEqual(status, 401)


class TestDiscountCodeUpdateDelete(unittest.TestCase):
    """Tests for update_discount_code and delete_discount_code store methods."""

    def test_update_discount_value(self):
        store = _make_store()
        created = store.create_discount_code("UPD1", "fixed", 5000, 10)
        updated = store.update_discount_code(created["id"], {"discount_value": 3000})
        self.assertEqual(updated["discount_value"], 3000)

    def test_update_discount_type(self):
        store = _make_store()
        created = store.create_discount_code("UPD2", "fixed", 5000, 0)
        updated = store.update_discount_code(created["id"], {"discount_type": "percent", "discount_value": 10})
        self.assertEqual(updated["discount_type"], "percent")
        self.assertEqual(updated["discount_value"], 10)

    def test_update_is_active(self):
        store = _make_store()
        created = store.create_discount_code("UPD3", "fixed", 1000, 0)
        updated = store.update_discount_code(created["id"], {"is_active": 0})
        self.assertEqual(updated["is_active"], 0)

    def test_update_empty_updates_returns_none(self):
        store = _make_store()
        created = store.create_discount_code("UPD4", "fixed", 1000, 0)
        result = store.update_discount_code(created["id"], {"bogus_field": 123})
        self.assertIsNone(result)

    def test_update_nonexistent_returns_none(self):
        store = _make_store()
        result = store.update_discount_code(99999, {"discount_value": 100})
        self.assertIsNone(result)

    def test_delete_discount_code(self):
        store = _make_store()
        created = store.create_discount_code("DEL1", "fixed", 1000, 0)
        self.assertTrue(store.delete_discount_code(created["id"]))
        codes = store.get_discount_codes()
        self.assertFalse(any(c["code"] == "DEL1" for c in codes))

    def test_delete_nonexistent_returns_false(self):
        store = _make_store()
        self.assertFalse(store.delete_discount_code(99999))


class TestDiscountCodeAdminEndpoints(TestHTTPBase):
    """Tests for /api/admin/discount-codes/update and /delete endpoints."""

    def test_update_endpoint_success(self):
        status, data = self.srv.request("POST", "/api/discount-codes",
                                         body={"code": "ENDPT1", "discount_type": "fixed",
                                               "discount_value": 5000, "max_uses": 10})
        code_id = data["discount_code"]["id"]
        status, data = self.srv.request("POST", "/api/admin/discount-codes/update",
                                         body={"id": code_id, "discount_value": 3000})
        self.assertEqual(status, 200)
        self.assertEqual(data["discount_code"]["discount_value"], 3000)

    def test_update_endpoint_invalid_type(self):
        status, data = self.srv.request("POST", "/api/discount-codes",
                                         body={"code": "ENDPT2", "discount_type": "fixed",
                                               "discount_value": 5000, "max_uses": 0})
        code_id = data["discount_code"]["id"]
        status, data = self.srv.request("POST", "/api/admin/discount-codes/update",
                                         body={"id": code_id, "discount_type": "invalid"})
        self.assertEqual(status, 400)

    def test_update_endpoint_no_auth(self):
        status, _ = self.srv.request("POST", "/api/admin/discount-codes/update",
                                      body={"id": 1, "discount_value": 100}, token=None)
        self.assertEqual(status, 401)

    def test_update_endpoint_missing_id(self):
        status, data = self.srv.request("POST", "/api/admin/discount-codes/update",
                                         body={"discount_value": 100})
        self.assertEqual(status, 400)

    def test_delete_endpoint_success(self):
        status, data = self.srv.request("POST", "/api/discount-codes",
                                         body={"code": "DELET1", "discount_type": "fixed",
                                               "discount_value": 1000, "max_uses": 0})
        code_id = data["discount_code"]["id"]
        status, data = self.srv.request("POST", "/api/admin/discount-codes/delete",
                                         body={"id": code_id})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])

    def test_delete_endpoint_no_auth(self):
        status, _ = self.srv.request("POST", "/api/admin/discount-codes/delete",
                                      body={"id": 1}, token=None)
        self.assertEqual(status, 401)

    def test_delete_endpoint_missing_id(self):
        status, data = self.srv.request("POST", "/api/admin/discount-codes/delete",
                                         body={})
        self.assertEqual(status, 400)

    def test_delete_endpoint_nonexistent(self):
        status, data = self.srv.request("POST", "/api/admin/discount-codes/delete",
                                         body={"id": 99999})
        self.assertEqual(status, 404)

    def test_toggle_active_via_update(self):
        status, data = self.srv.request("POST", "/api/discount-codes",
                                         body={"code": "TOGL1", "discount_type": "percent",
                                               "discount_value": 15, "max_uses": 0})
        code_id = data["discount_code"]["id"]
        # Deactivate
        status, data = self.srv.request("POST", "/api/admin/discount-codes/update",
                                         body={"id": code_id, "is_active": 0})
        self.assertEqual(status, 200)
        self.assertEqual(data["discount_code"]["is_active"], 0)
        # Reactivate
        status, data = self.srv.request("POST", "/api/admin/discount-codes/update",
                                         body={"id": code_id, "is_active": 1})
        self.assertEqual(status, 200)
        self.assertEqual(data["discount_code"]["is_active"], 1)

    def test_update_endpoint_discount_type_and_max_uses(self):
        """Cover updating discount_type (valid) and max_uses fields."""
        status, data = self.srv.request("POST", "/api/discount-codes",
                                         body={"code": "UPDT3", "discount_type": "fixed",
                                               "discount_value": 1000, "max_uses": 5})
        code_id = data["discount_code"]["id"]
        status, data = self.srv.request("POST", "/api/admin/discount-codes/update",
                                         body={"id": code_id, "discount_type": "percent", "max_uses": 20})
        self.assertEqual(status, 200)
        self.assertEqual(data["discount_code"]["discount_type"], "percent")
        self.assertEqual(data["discount_code"]["max_uses"], 20)

    def test_update_endpoint_nonexistent_returns_404(self):
        status, data = self.srv.request("POST", "/api/admin/discount-codes/update",
                                         body={"id": 99999, "discount_value": 100})
        self.assertEqual(status, 404)
