from __future__ import annotations

import time
from typing import Optional, Dict, Any

from app.core.config import DDB_TABLE
from app.services.aws_clients import ddb_client

ddb = ddb_client()

def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def pk_job(job_id: str) -> str:
    return f"JOB#{job_id}"

def pk_cache(score_hash: str, config_hash: str) -> str:
    return f"CACHE#{score_hash}#{config_hash}"

def get_item(pk: str) -> Optional[Dict[str, Any]]:
    resp = ddb.get_item(TableName=DDB_TABLE, Key={"PK": {"S": pk}})
    return resp.get("Item")

def _ddb_to_py(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert a DynamoDB low-level item ({"attr": {"S": "x"}}) into plain python dict.
    Handles S/N/BOOL minimally (enough for our usage).
    """
    out: Dict[str, Any] = {}
    for k, v in item.items():
        if "S" in v:
            out[k] = v["S"]
        elif "N" in v:
            n = v["N"]
            out[k] = int(n) if n.isdigit() else float(n)
        elif "BOOL" in v:
            out[k] = bool(v["BOOL"])
        else:
            # fallback: keep raw (you can expand later if needed)
            out[k] = v
    return out

def get_cache(score_hash: str, config_hash: str) -> Optional[str]:
    item = get_item(pk_cache(score_hash, config_hash))
    if not item:
        return None
    return item["result_s3_key"]["S"]

def put_cache(score_hash: str, config_hash: str, result_key: str) -> None:
    ddb.put_item(
        TableName=DDB_TABLE,
        Item={
            "PK": {"S": pk_cache(score_hash, config_hash)},
            "result_s3_key": {"S": result_key},
            "updated_at": {"S": now_iso()},
        },
    )

def put_job(job_id: str, score_hash: str, config_hash: str, input_key: str) -> None:
    ddb.put_item(
        TableName=DDB_TABLE,
        Item={
            "PK": {"S": pk_job(job_id)},
            "status": {"S": "QUEUED"},
            "score_hash": {"S": score_hash},
            "config_hash": {"S": config_hash},
            "input_s3_key": {"S": input_key},
            "created_at": {"S": now_iso()},
            "updated_at": {"S": now_iso()},
        },
    )

def update_job(job_id: str, **fields: str) -> None:
    expr_parts = []
    names = {"#u": "updated_at"}
    values = {":u": {"S": now_iso()}}

    for i, (k, v) in enumerate(fields.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = {"S": str(v)}
        expr_parts.append(f"#k{i} = :v{i}")

    update_expr = "SET " + ", ".join(expr_parts + ["#u = :u"])
    ddb.update_item(
        TableName=DDB_TABLE,
        Key={"PK": {"S": pk_job(job_id)}},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )

def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    item = get_item(pk_job(job_id))
    if not item:
        return None
    return _ddb_to_py(item)