import os
from dotenv import load_dotenv

load_dotenv()

AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
S3_BUCKET = os.getenv("S3_BUCKET", "")
SQS_QUEUE_URL = os.getenv("SQS_QUEUE_URL", "")
DDB_TABLE = os.getenv("DDB_TABLE", "")
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
DEMO_SYNC_MAX_UPLOAD_BYTES = int(os.getenv("DEMO_SYNC_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
DEMO_SYNC_MAX_EVENTS = int(os.getenv("DEMO_SYNC_MAX_EVENTS", "5000"))
DEMO_SYNC_MAX_RUNTIME_SECONDS = float(os.getenv("DEMO_SYNC_MAX_RUNTIME_SECONDS", "30"))

def require_env() -> None:
    missing = [k for k, v in {
        "S3_BUCKET": S3_BUCKET,
        "SQS_QUEUE_URL": SQS_QUEUE_URL,
        "DDB_TABLE": DDB_TABLE,
    }.items() if not v]
    if missing:
        raise RuntimeError(f"Missing env vars: {', '.join(missing)}")
