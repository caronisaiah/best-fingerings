from fastapi import FastAPI
from app.api.routes import router

app = FastAPI(title="Best Fingerings API", version="0.0.1")
app.include_router(router)