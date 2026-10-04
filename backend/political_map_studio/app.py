from __future__ import annotations
import json, tempfile
from pathlib import Path
from threading import Lock
from fastapi import Body, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import cairosvg
from .processing import process, safe_vector_path
from .library import cached_project, catalog, entry_by_id, preview_path, preview_thumbnail

_export_lock = Lock()


def _convert_export(format: str, body: bytes, page_dpi: int) -> bytes:
    # Keep large conversions serialized without blocking unrelated API requests.
    with _export_lock:
        if format == "png":
            return cairosvg.svg2png(bytestring=body, dpi=page_dpi)
        return cairosvg.svg2pdf(bytestring=body)


app=FastAPI(title="Political Map Studio",version="0.1.0")
app.add_middleware(CORSMiddleware,allow_origins=["http://127.0.0.1:4173","http://localhost:4173"],allow_methods=["*"],allow_headers=["*"])
@app.get("/api/health")
def health(): return {"status":"ok","version":"0.1.0"}
@app.get("/api/library")
def election_library(): return catalog()
@app.get("/api/library/{entry_id}/preview")
def election_library_preview(entry_id: str,width:int|None=None):
    """Published preview at full resolution, or a cached downscaled thumbnail when `width` is given."""
    try:
        thumbnail=preview_thumbnail(entry_id,width) if width is not None else None
        path=thumbnail[0] if thumbnail else preview_path(entry_by_id(entry_id))
    except KeyError as exc:
        raise HTTPException(404, "Unknown library election") from exc
    if path is None:
        raise HTTPException(404, "No published preview for this election")
    return FileResponse(path,media_type=thumbnail[1] if thumbnail else None)
@app.get("/api/library/{entry_id}")
async def election_library_project(entry_id:str,request:Request):
    try:
        path=await run_in_threadpool(cached_project,entry_id)
    except KeyError as exc:raise HTTPException(404,"Unknown library election") from exc
    except Exception as exc:raise HTTPException(500,f"Library project failed: {exc}") from exc
    etag=f'"{path.stem}"'
    if request.headers.get("if-none-match")==etag:return Response(status_code=304,headers={"ETag":etag})
    # The serialized project is written once per source revision; serving the file directly avoids
    # deserializing and re-encoding every precinct geometry on each election switch.
    return FileResponse(path,media_type="application/json",headers={"ETag":etag,"Cache-Control":"no-cache"})
@app.post("/api/import")
async def import_data(geography:UploadFile=File(...),results:UploadFile=File(...),project:str=Form(...),geography_key:str=Form(...),result_key:str=Form(...),results_format:str=Form(...)):
    try:
        with tempfile.TemporaryDirectory(prefix="pmap-import-") as folder:
            root=Path(folder); geo_upload=root/Path(geography.filename or "geography").name; result_path=root/Path(results.filename or "results.csv").name
            geo_upload.write_bytes(await geography.read());result_path.write_bytes(await results.read())
            if geo_upload.stat().st_size>250_000_000 or result_path.stat().st_size>100_000_000:raise ValueError("Upload exceeds local safety limit")
            return process(json.loads(project),safe_vector_path(geo_upload,root/"shape"),result_path,geography_key,result_key,results_format)
    except Exception as exc: raise HTTPException(400,str(exc)) from exc
@app.post("/api/export/{format}")
async def export(format:str,body:bytes=Body(...,media_type="image/svg+xml"),page_dpi:int=Header(220,alias="X-Page-Dpi")):
    if format not in {"png","pdf"}:raise HTTPException(404,"Unsupported export format")
    try:
        data=await run_in_threadpool(_convert_export,format,body,page_dpi)
        mime="image/png" if format=="png" else "application/pdf"
        return Response(data,media_type=mime)
    except Exception as exc: raise HTTPException(400,f"Vector export failed: {exc}") from exc

dist=Path(__file__).resolve().parents[2]/"dist"
if dist.exists():app.mount("/",StaticFiles(directory=dist,html=True),name="studio")
