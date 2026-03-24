from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query

from app.core.config import require_env, S3_BUCKET
from app.services.aws_clients import s3_client
from app.services.jobs_repo import get_job

router = APIRouter()

DEFAULT_PRESIGN_EXPIRES = 3600


def _presign_result_url(*, key: str, expires_in: int) -> Optional[str]:
    """
    Best-effort: if IAM/creds don't allow presign, return None (don't fail /jobs).
    """
    try:
        s3 = s3_client()
        return s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=expires_in,
        )
    except Exception:
        return None


@router.get("/jobs/{job_id}")
def get_job_status(
    job_id: str,
    presign_expires_seconds: int = Query(default=DEFAULT_PRESIGN_EXPIRES, ge=60, le=7 * 24 * 3600),
) -> Dict[str, Any]:
    require_env()

    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    status = job.get("status")

    result_key = job.get("result_s3_key")
    result_url = None
    if status == "SUCCEEDED" and result_key:
        result_url = _presign_result_url(key=result_key, expires_in=presign_expires_seconds)

    # Nice for polling UIs (front-end can use this as a default backoff)
    retry_after_ms = 1500 if status in ("QUEUED", "RUNNING") else None

    return {
        "job_id": job_id,
        "status": status,
        "score_hash": job.get("score_hash"),
        "config_hash": job.get("config_hash"),
        "input_s3_key": job.get("input_s3_key"),
        "result_s3_key": result_key,
        "result_url": result_url,  # ✅ NEW
        "error": job.get("error"),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "parse_ms": job.get("parse_ms"),
        "optimize_ms": job.get("optimize_ms"),
        "retry_after_ms": retry_after_ms,  # ✅ NEW
    }