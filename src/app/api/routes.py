from fastapi import APIRouter
from app.api.analyze import router as analyze_router
from app.api.fingerings import router as fingerings_router
from app.api.jobs import router as jobs_router

router = APIRouter()

@router.get("/health")
def health():
    return {"status": "ok"}

@router.get("/version")
def version():
    return {"api_version": "0.0.1", "algorithm_version": "0.0.1"}

router.include_router(analyze_router)
router.include_router(fingerings_router)
router.include_router(jobs_router)