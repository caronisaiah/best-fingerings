from fastapi import APIRouter

from app.api.results import router as results_router
from app.api.analyze import router as analyze_router
from app.api.fingerings import router as fingerings_router
from app.api.jobs import router as jobs_router

# ✅ versions
from app.services.fingering_engine import ALGO_VERSION
from app.services.musicxml_parser import PARSER_VERSION, ANCHOR_SCHEMA_VERSION
from app.api.fingerings import RESULT_SCHEMA_VERSION  # make sure it's exported

router = APIRouter()


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/version")
def version():
    return {
        "api_version": "0.0.1",  # bump when you change API behavior
        "algorithm_version": ALGO_VERSION,
        "parser_version": PARSER_VERSION,
        "anchor_schema_version": ANCHOR_SCHEMA_VERSION,
        "result_schema_version": RESULT_SCHEMA_VERSION,
    }


router.include_router(analyze_router)
router.include_router(fingerings_router)
router.include_router(jobs_router)
router.include_router(results_router)