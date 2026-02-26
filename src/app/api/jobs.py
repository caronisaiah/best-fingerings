from fastapi import APIRouter, HTTPException

from app.services.jobs_repo import get_item, pk_job

router = APIRouter()

@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    item = get_item(pk_job(job_id))
    if not item:
        raise HTTPException(status_code=404, detail="job not found")

    def s(key: str):
        return item.get(key, {}).get("S")

    return {
        "job_id": job_id,
        "status": s("status"),
        "score_hash": s("score_hash"),
        "config_hash": s("config_hash"),
        "input_s3_key": s("input_s3_key"),
        "result_s3_key": s("result_s3_key"),
        "error": s("error"),
        "created_at": s("created_at"),
        "updated_at": s("updated_at"),
        "parse_ms": s("parse_ms"),
        "optimize_ms": s("optimize_ms"),
    }