from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.core.config import S3_BUCKET, SQS_QUEUE_URL, require_env
from app.services.aws_clients import s3_client, sqs_client
from app.services.fingering_engine import ALGO_VERSION, FingeringConfig, normalize_config
from app.services.jobs_repo import get_cache, put_job
from app.services.musicxml_parser import ANCHOR_SCHEMA_VERSION, PARSER_VERSION

router = APIRouter()

# Bump any time you change /fingerings response or result payload shape incompatibly
RESULT_SCHEMA_VERSION = 3

# Default presigned URL TTL (seconds)
DEFAULT_PRESIGN_EXPIRES = 3600


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def config_hash_from_params(
    config: FingeringConfig,
    *,
    algorithm_version: str,
    parser_version: str,
    anchor_schema_version: int,
    result_schema_version: int,
) -> str:
    """
    Cache key must change when ANY logic that affects outputs changes.
    """
    payload = {
        "difficulty": config.difficulty,
        "style_bias": config.style_bias,
        "hand_size": config.hand_size,
        "articulation_bias": config.articulation_bias,
        "locked_note_fingerings": config.locked_note_fingerings,
        "algorithm_version": algorithm_version,
        "parser_version": parser_version,
        "anchor_schema_version": int(anchor_schema_version),
        "result_schema_version": int(result_schema_version),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _parse_locked_note_fingerings_json(raw: str) -> Dict[str, int]:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"locked_note_fingerings_json must be valid JSON: {exc.msg}") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="locked_note_fingerings_json must be a JSON object")

    out: Dict[str, int] = {}
    for note_id, finger in payload.items():
        if not isinstance(note_id, str) or not note_id:
            raise HTTPException(status_code=400, detail="locked note ids must be non-empty strings")
        try:
            finger_val = int(finger)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"locked finger for {note_id} must be an integer") from exc
        if not 1 <= finger_val <= 5:
            raise HTTPException(status_code=400, detail=f"locked finger for {note_id} must be between 1 and 5")
        out[note_id] = finger_val
    return out


def _guess_content_type(filename: str) -> str:
    name = (filename or "").lower()
    if name.endswith(".mxl"):
        # MXL is a ZIP container; correct-ish content-type is often this
        return "application/vnd.recordare.musicxml"
    return "application/xml"


def _presign_result_url(
    *,
    s3,
    key: str,
    expires_in: int = DEFAULT_PRESIGN_EXPIRES,
) -> Optional[str]:
    try:
        return s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=int(expires_in),
        )
    except Exception:
        # If IAM/creds don't allow presign, omit URL rather than failing request
        return None


@router.post("/fingerings")
async def fingerings(
    file: UploadFile = File(...),
    difficulty: str = Form(default="standard"),
    style_bias: str = Form(default="neutral"),
    hand_size: str = Form(default="medium"),
    articulation_bias: str = Form(default="auto"),
    locked_note_fingerings_json: str = Form(default="{}"),
    force_recompute: bool = Form(default=False),
    presign_expires_seconds: int = Form(default=DEFAULT_PRESIGN_EXPIRES),
) -> Dict[str, Any]:
    require_env()

    filename = file.filename or ""
    name = filename.lower()

    if not (name.endswith(".xml") or name.endswith(".musicxml") or name.endswith(".mxl")):
        raise HTTPException(status_code=400, detail="Upload a MusicXML file (.xml/.musicxml/.mxl)")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    if not 60 <= int(presign_expires_seconds) <= 7 * 24 * 3600:
        raise HTTPException(status_code=400, detail="presign_expires_seconds must be between 60 and 604800")

    locked_note_fingerings = _parse_locked_note_fingerings_json(locked_note_fingerings_json)
    config = normalize_config(
        FingeringConfig(
            difficulty=difficulty,
            style_bias=style_bias,
            hand_size=hand_size,
            articulation_bias=articulation_bias,
            locked_note_fingerings=locked_note_fingerings,
        )
    )

    score_hash = sha256_bytes(data)
    cfg_hash = config_hash_from_params(
        config=config,
        algorithm_version=ALGO_VERSION,
        parser_version=PARSER_VERSION,
        anchor_schema_version=int(ANCHOR_SCHEMA_VERSION),
        result_schema_version=int(RESULT_SCHEMA_VERSION),
    )

    versions_payload = {
        "algorithm_version": ALGO_VERSION,
        "parser_version": PARSER_VERSION,
        "anchor_schema_version": ANCHOR_SCHEMA_VERSION,
        "result_schema_version": RESULT_SCHEMA_VERSION,
    }
    preferences_payload = {
        "difficulty": config.difficulty,
        "style_bias": config.style_bias,
        "hand_size": config.hand_size,
        "articulation_bias": config.articulation_bias,
        "locked_note_count": len(config.locked_note_fingerings),
    }

    # Cache hit path
    if not force_recompute:
        cached_key = get_cache(score_hash, cfg_hash)
        if cached_key:
            s3 = s3_client()
            result_url = _presign_result_url(
                s3=s3,
                key=cached_key,
                expires_in=int(presign_expires_seconds),
            )
            return {
                "status": "SUCCEEDED",
                "job_id": None,  # cached -> no job created
                "score_hash": score_hash,
                "config_hash": cfg_hash,
                "result_s3_key": cached_key,
                "result_url": result_url,
                "cached": True,
                "versions": versions_payload,
                "preferences": preferences_payload,
            }

    # Upload input
    ext = ".mxl" if name.endswith(".mxl") else ".musicxml"
    input_key = f"scores/{score_hash}/input{ext}"

    s3 = s3_client()
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=input_key,
        Body=data,
        ContentType=_guess_content_type(filename),
    )

    # Create job + enqueue
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
                "preferences": {
                    "difficulty": config.difficulty,
                    "style_bias": config.style_bias,
                    "hand_size": config.hand_size,
                    "articulation_bias": config.articulation_bias,
                    "locked_note_fingerings": config.locked_note_fingerings,
                },
                "versions": versions_payload,
            }
        ),
    )

    return {
        "status": "QUEUED",
        "job_id": job_id,
        "score_hash": score_hash,
        "config_hash": cfg_hash,
        "cached": False,
        "versions": versions_payload,
        "preferences": preferences_payload,
    }
