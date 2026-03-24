from __future__ import annotations

import json
import time

from app.core.config import require_env, S3_BUCKET, SQS_QUEUE_URL
from app.services.aws_clients import s3_client, sqs_client
from app.services.fingering_engine import ALGO_VERSION, FingeringConfig, generate_fingerings, normalize_config
from app.services.jobs_repo import put_cache, update_job
from app.services.musicxml_parser import (
    ANCHOR_SCHEMA_VERSION,
    PARSER_VERSION,
    parse_musicxml_to_events,
)


def main():
    require_env()
    sqs = sqs_client()
    s3 = s3_client()

    print("Worker started; polling SQS...")

    while True:
        resp = sqs.receive_message(
            QueueUrl=SQS_QUEUE_URL,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=20,
        )

        msgs = resp.get("Messages", [])
        if not msgs:
            continue

        msg = msgs[0]
        receipt = msg["ReceiptHandle"]
        body = json.loads(msg["Body"])

        job_id = body["job_id"]
        score_hash = body["score_hash"]
        config_hash = body["config_hash"]
        input_key = body["input_s3_key"]
        preferences = body.get("preferences") or {}
        versions = body.get("versions") or {}

        try:
            update_job(job_id, status="RUNNING")

            obj = s3.get_object(Bucket=S3_BUCKET, Key=input_key)
            xml_bytes = obj["Body"].read()

            t0 = time.time()
            analysis = parse_musicxml_to_events(xml_bytes)
            parse_ms = int((time.time() - t0) * 1000)

            t1 = time.time()
            config = normalize_config(
                FingeringConfig(
                    difficulty=preferences.get("difficulty", "standard"),
                    style_bias=preferences.get("style_bias", "neutral"),
                    hand_size=preferences.get("hand_size", "medium"),
                    articulation_bias=preferences.get("articulation_bias", "auto"),
                    locked_note_fingerings=preferences.get("locked_note_fingerings", {}),
                )
            )
            fingerings = generate_fingerings(analysis.hands, config=config)
            optimize_ms = int((time.time() - t1) * 1000)

            result_payload = {
                "job_id": job_id,
                "score_hash": score_hash,
                "config_hash": config_hash,
                "preferences": {
                    "difficulty": config.difficulty,
                    "style_bias": config.style_bias,
                    "hand_size": config.hand_size,
                    "articulation_bias": config.articulation_bias,
                    "locked_note_count": len(config.locked_note_fingerings),
                },
                "versions": {
                    "algorithm_version": ALGO_VERSION,
                    "parser_version": PARSER_VERSION,
                    "anchor_schema_version": ANCHOR_SCHEMA_VERSION,
                    "result_schema_version": versions.get("result_schema_version"),
                },
                "analysis": analysis.model_dump(),
                "fingerings": fingerings.model_dump(),
            }

            result_key = f"results/{score_hash}/{config_hash}/fingerings.json"
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=result_key,
                Body=json.dumps(result_payload).encode("utf-8"),
                ContentType="application/json",
            )

            put_cache(score_hash, config_hash, result_key)

            # Optional: also store versions in the job row for quick debugging without S3 fetch
            update_job(
                job_id,
                status="SUCCEEDED",
                result_s3_key=result_key,
                parse_ms=str(parse_ms),
                optimize_ms=str(optimize_ms),
                algorithm_version=ALGO_VERSION,
                parser_version=PARSER_VERSION,
                anchor_schema_version=str(ANCHOR_SCHEMA_VERSION),
            )

            sqs.delete_message(QueueUrl=SQS_QUEUE_URL, ReceiptHandle=receipt)
            print(f"SUCCEEDED job={job_id} result={result_key}")

        except Exception as e:
            update_job(job_id, status="FAILED", error=f"{type(e).__name__}: {e}")
            # Don't delete message so SQS retries; DLQ after max receives
            print(f"FAILED job={job_id} err={type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
