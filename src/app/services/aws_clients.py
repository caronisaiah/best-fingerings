import boto3
from app.core.config import AWS_REGION

_session = boto3.session.Session(region_name=AWS_REGION)

def s3_client():
    return _session.client("s3")

def sqs_client():
    return _session.client("sqs")

def ddb_client():
    return _session.client("dynamodb")