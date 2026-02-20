from fastapi import APIRouter
from app.api.analyze import router as analyze_router

router = APIRouter()

@router.get("/health")
def health():
    return {"status": "ok"}

@router.get("/version")
def version():
    return {"api_version": "0.0.1", "algorithm_version": "0.0.1"}

router.include_router(analyze_router)