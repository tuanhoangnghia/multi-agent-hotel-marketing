from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Optional

from google.cloud import firestore

from .config import get_settings


@lru_cache
def _db() -> firestore.Client:
    settings = get_settings()
    return firestore.Client(
        project=settings.gcp_project_id or None,
        database=settings.firestore_database,
    )


def _collection():
    return _db().collection(get_settings().firestore_collection)


def create_job(
    job_id: str,
    hotel_id: str,
    folder_id: str,
    context: dict,
    target_duration_seconds: list[int],
    analyze_only: bool = False,
    previous_analyses: Optional[list[dict]] = None,
) -> None:
    # Hai tham số cuối đều có mặc định -> lời gọi cũ (POST /api/jobs) giữ nguyên hành vi đầy đủ.
    now = datetime.now(timezone.utc)
    _collection().document(job_id).set(
        {
            "hotel_id": hotel_id,
            "folder_id": folder_id,
            "context": context,
            "target_duration_seconds": target_duration_seconds,
            "analyze_only": analyze_only,
            "previous_analyses": previous_analyses or [],
            "status": "queued",
            "output": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
    )


def create_synthesize_job(
    job_id: str,
    hotel_id: str,
    analyses: list[dict],
    context: dict,
    target_duration_seconds: list[int],
) -> None:
    """Job CHỈ chạy bước tổng hợp: analyses là đầu vào có sẵn nên không cần folder_id.

    Viết riêng thay vì thêm tham số vào create_job(): create_job đang phục vụ 2 endpoint đã
    tích hợp với ứng dụng khác, không đụng vào cho chắc.
    """
    now = datetime.now(timezone.utc)
    _collection().document(job_id).set(
        {
            "hotel_id": hotel_id,
            "folder_id": None,
            "context": context,
            "target_duration_seconds": target_duration_seconds,
            "analyses": analyses,
            "analyze_only": False,
            "synthesize_only": True,
            "status": "queued",
            "output": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
    )


def update_job(job_id: str, **fields: Any) -> None:
    fields["updated_at"] = datetime.now(timezone.utc)
    _collection().document(job_id).update(fields)


def get_job(job_id: str) -> Optional[dict]:
    doc = _collection().document(job_id).get()
    return doc.to_dict() if doc.exists else None
