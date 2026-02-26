import os
from dotenv import load_dotenv

load_dotenv()

AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
S3_BUCKET = os.getenv("S3_BUCKET", "")
SQS_QUEUE_URL = os.getenv("SQS_QUEUE_URL", "")
DDB_TABLE = os.getenv("DDB_TABLE", "")

def require_env() -> None:
    missing = [k for k, v in {
        "S3_BUCKET": S3_BUCKET,
        "SQS_QUEUE_URL": SQS_QUEUE_URL,
        "DDB_TABLE": DDB_TABLE,
    }.items() if not v]
    if missing:
        raise RuntimeError(f"Missing env vars: {', '.join(missing)}")