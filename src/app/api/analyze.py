from fastapi import APIRouter, File, UploadFile, HTTPException

from app.services.musicxml_parser import parse_musicxml_to_events

router = APIRouter()

@router.post("/analyze-score")
async def analyze_score(file: UploadFile = File(...)):
    filename = (file.filename or "").lower()

    if not (filename.endswith(".xml") or filename.endswith(".musicxml") or filename.endswith(".mxl")):
        # We'll still try parsing if content is MusicXML, but v1 keep it strict.
        raise HTTPException(status_code=400, detail="Upload a MusicXML file (.xml/.musicxml/.mxl)")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        resp = parse_musicxml_to_events(data)
        return resp
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse MusicXML: {type(e).__name__}: {e}")