from __future__ import annotations

import json
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from app.core.config import require_env, S3_BUCKET
from app.services.aws_clients import s3_client
from app.services.jobs_repo import get_job

router = APIRouter()


def _require_succeeded_job(job_id: str) -> Dict[str, Any]:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    status = job.get("status")
    if status != "SUCCEEDED":
        raise HTTPException(
            status_code=409,
            detail={"status": status, "error": job.get("error")},
        )

    result_key = job.get("result_s3_key")
    if not result_key:
        raise HTTPException(status_code=404, detail="Job has no result_s3_key")

    return {"job": job, "result_key": result_key}


def _fetch_result_json(result_key: str) -> Dict[str, Any]:
    s3 = s3_client()
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=result_key)
        data = obj["Body"].read()
        return json.loads(data.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"S3 fetch/parse failed: {type(e).__name__}: {e}")

@router.get("/results/by-key")
def get_result_by_key(key: str = Query(..., min_length=1)):
    require_env()
    s3 = s3_client()
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        data = obj["Body"].read()
        payload = json.loads(data.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"S3 fetch/parse failed: {type(e).__name__}: {e}")

    return JSONResponse(content=payload)
    
@router.get("/results/{job_id}")
def get_result(job_id: str):
    require_env()

    info = _require_succeeded_job(job_id)
    payload = _fetch_result_json(info["result_key"])
    return JSONResponse(content=payload)


# ✅ NEW: small payload for debugging + UI badges
@router.get("/results/{job_id}/warnings")
def get_result_warnings(job_id: str):
    require_env()

    info = _require_succeeded_job(job_id)
    payload = _fetch_result_json(info["result_key"])

    analysis_warnings = (payload.get("analysis") or {}).get("warnings", [])
    fingering_warnings = (payload.get("fingerings") or {}).get("warnings", [])

    return {
        "job_id": job_id,
        "analysis_warnings": analysis_warnings,
        "analysis_warnings_count": len(analysis_warnings),
        "fingering_warnings": fingering_warnings,
        "fingering_warnings_count": len(fingering_warnings),
    }