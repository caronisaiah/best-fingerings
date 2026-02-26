from __future__ import annotations

import hashlib
import json
import uuid

from fastapi import APIRouter, File, UploadFile, HTTPException

from app.core.config import S3_BUCKET, SQS_QUEUE_URL, require_env
from app.services.aws_clients import s3_client, sqs_client
from app.services.fingering_engine import ALGO_VERSION
from app.services.jobs_repo import get_cache, put_job

router = APIRouter()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def config_hash_from_params(difficulty: str, style_bias: str) -> str:
    # IMPORTANT: include algorithm version so cache invalidates when fingering logic changes
    payload = {
        "difficulty": difficulty,
        "style_bias": style_bias,
        "algorithm_version": ALGO_VERSION,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


@router.post("/fingerings")
async def fingerings(
    file: UploadFile = File(...),
    difficulty: str = "standard",
    style_bias: str = "neutral",
):
    require_env()

    name = (file.filename or "").lower()
    if not (name.endswith(".xml") or name.endswith(".musicxml") or name.endswith(".mxl")):
        raise HTTPException(status_code=400, detail="Upload a MusicXML file (.xml/.musicxml/.mxl)")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    score_hash = sha256_bytes(data)
    cfg_hash = config_hash_from_params(difficulty, style_bias)

    cached_key = get_cache(score_hash, cfg_hash)
    if cached_key:
        return {
            "status": "SUCCEEDED",
            "job_id": None,
            "score_hash": score_hash,
            "config_hash": cfg_hash,
            "result_s3_key": cached_key,
            "cached": True,
        }

    input_key = f"scores/{score_hash}/input.musicxml"
    s3 = s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=input_key, Body=data, ContentType="application/xml")

    job_id = str(uuid.uuid4())
    put_job(job_id=job_id, score_hash=score_hash, config_hash=cfg_hash, input_key=input_key)

    sqs = sqs_client()
    sqs.send_message(
        QueueUrl=SQS_QUEUE_URL,
        MessageBody=json.dumps(
            {
                "job_id": job_id,
                "score_hash": score_hash,
                "config_hash": cfg_hash,
                "input_s3_key": input_key,
            }
        ),
    )

    return {"status": "QUEUED", "job_id": job_id, "score_hash": score_hash, "config_hash": cfg_hash}