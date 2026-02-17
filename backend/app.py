import os
from fastapi import FastAPI, Request
from mangum import Mangum

app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/version")
def version():
    return {"version": os.environ.get("VERSION", "dev")}

# Mangum handler for AWS Lambda
handler = Mangum(app)
