from fastapi import APIRouter

router = APIRouter()

@router.get("/health")
def health():
    return {"status": "ok"}

@router.get("/version")
def version():
    return {"api_version": "0.0.1", "algorithm_version": "0.0.1"}