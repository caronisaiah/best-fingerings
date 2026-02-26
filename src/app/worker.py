from __future__ import annotations

import json
import time

from app.core.config import require_env, S3_BUCKET, SQS_QUEUE_URL
from app.services.aws_clients import s3_client, sqs_client
from app.services.jobs_repo import update_job, put_cache
from app.services.musicxml_parser import parse_musicxml_to_events
from app.services.fingering_engine import generate_fingerings


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

        try:
            update_job(job_id, status="RUNNING")

            obj = s3.get_object(Bucket=S3_BUCKET, Key=input_key)
            xml_bytes = obj["Body"].read()

            t0 = time.time()
            analysis = parse_musicxml_to_events(xml_bytes)
            parse_ms = int((time.time() - t0) * 1000)

            t1 = time.time()
            fingerings = generate_fingerings(analysis.hands)
            optimize_ms = int((time.time() - t1) * 1000)

            result_payload = {
                "job_id": job_id,
                "score_hash": score_hash,
                "config_hash": config_hash,
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
            update_job(
                job_id,
                status="SUCCEEDED",
                result_s3_key=result_key,
                parse_ms=str(parse_ms),
                optimize_ms=str(optimize_ms),
            )

            sqs.delete_message(QueueUrl=SQS_QUEUE_URL, ReceiptHandle=receipt)
            print(f"SUCCEEDED job={job_id} result={result_key}")

        except Exception as e:
            update_job(job_id, status="FAILED", error=f"{type(e).__name__}: {e}")
            # Don't delete message so SQS retries; DLQ after max receives
            print(f"FAILED job={job_id} err={type(e).__name__}: {e}")


if __name__ == "__main__":
    main()