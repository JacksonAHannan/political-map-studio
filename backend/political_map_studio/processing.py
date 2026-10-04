from __future__ import annotations
import hashlib, json, re, tempfile, zipfile
from pathlib import Path
from typing import Any
import geopandas as gpd
import pandas as pd
from pyproj import Transformer

ALLOWED_VECTOR={".geojson",".json",".gpkg",".zip"}
SHAPE_PARTS={".shp",".shx",".dbf",".prj",".cpg"}
def normalize(value:Any)->str: return re.sub(r"\s+"," ",str(value).strip()).casefold()
def sha256(path:Path)->str: return hashlib.sha256(path.read_bytes()).hexdigest()

def safe_vector_path(upload_path:Path, work:Path)->Path:
    if upload_path.suffix.lower() == ".topojson": raise ValueError("TopoJSON import is not supported; convert it to GeoJSON")
    if upload_path.suffix.lower() not in ALLOWED_VECTOR: raise ValueError(f"Unsupported geography type: {upload_path.suffix}")
    if upload_path.suffix.lower() != ".zip": return upload_path
    with zipfile.ZipFile(upload_path) as archive:
        members=[m for m in archive.infolist() if not m.is_dir()]
        if not members or any(Path(m.filename).suffix.lower() not in SHAPE_PARTS for m in members): raise ValueError("Shapefile ZIP may contain only .shp/.shx/.dbf/.prj/.cpg files")
        if any(Path(m.filename).is_absolute() or ".." in Path(m.filename).parts for m in members): raise ValueError("Unsafe archive path")
        stems={Path(m.filename).stem for m in members if Path(m.filename).suffix.lower()==".shp"}
        if len(stems)!=1: raise ValueError("Shapefile ZIP must contain exactly one .shp layer")
        archive.extractall(work)
        return next(work.rglob("*.shp"))

def read_geography(path:Path)->gpd.GeoDataFrame:
    if path.suffix.lower()==".topojson": raise ValueError("TopoJSON import is not supported; convert it to GeoJSON")
    return gpd.read_file(path)

def _candidate_columns(project:dict, results:pd.DataFrame, result_key:str)->list[tuple[str,str]]:
    configured=[]
    for candidate in project["data"]["candidates"]:
        source=next((name for name in candidate.get("sourceNames",[]) if name in results.columns),None)
        if source is None and candidate["id"] in results.columns: source=candidate["id"]
        if source is not None: configured.append((candidate["id"],source))
    if configured:return configured
    numeric=[c for c in results.columns if c!=result_key and pd.api.types.is_numeric_dtype(results[c])]
    return [(normalize(c).replace(" ","-"),c) for c in numeric]

def process(project:dict, geography_path:Path, results_path:Path, geography_key:str, result_key:str, results_format:str)->dict:
    diagnostics=[]; geography=read_geography(geography_path); results=pd.read_csv(results_path); coordinate_transformer=None
    if geography.crs is None: diagnostics.append({"severity":"error","code":"GEOMETRY_CRS_MISSING","message":"Geography has no declared CRS","fix":"Assign a CRS before importing."})
    if geography_key not in geography: raise ValueError(f"Geography field not found: {geography_key}")
    if result_key not in results: raise ValueError(f"Results field not found: {result_key}")
    null_geoms=int(geography.geometry.isna().sum()); empty_geoms=int(geography.geometry.is_empty.sum()); invalid=int((~geography.geometry.is_valid & geography.geometry.notna()).sum())
    for count,code,message in [(null_geoms,"NULL_GEOMETRY","polygons have null geometry"),(empty_geoms,"EMPTY_GEOMETRY","polygons have empty geometry"),(invalid,"INVALID_GEOMETRY","polygons have invalid geometry")]:
        if count: diagnostics.append({"severity":"error" if code=="NULL_GEOMETRY" else "warning","code":code,"message":f"{count} {message}","count":count,"fix":"Inspect these features; invalid geometries are repaired only in the render cache."})
    geo_dup=int(geography[geography_key].astype(str).duplicated(keep=False).sum()); result_dup=int(results[result_key].astype(str).duplicated(keep=False).sum())
    if geo_dup:diagnostics.append({"severity":"error","code":"DUPLICATE_GEOGRAPHY_KEYS","message":f"{geo_dup} polygons use duplicate join keys","count":geo_dup})
    if result_dup and results_format=="wide":diagnostics.append({"severity":"warning","code":"DUPLICATE_RESULT_KEYS","message":f"{result_dup} result rows use duplicate join keys; votes will be summed","count":result_dup})
    geography=geography.loc[geography.geometry.notna() & ~geography.geometry.is_empty].copy()
    if invalid: geography.geometry=geography.geometry.make_valid()
    if geography.crs is not None:
        target=geography.estimate_utm_crs() or geography.crs
        if target != geography.crs:
            coordinate_transformer=Transformer.from_crs(geography.crs,target,always_xy=True)
            diagnostics.append({"severity":"info","code":"PROJECTION_APPLIED","message":f"Render cache projected to {target} for stable planar geometry","fix":"Choose the map projection and extent in the map inspector."})
        geography=geography.to_crs(target)
    geography["__joinKey"]=geography[geography_key].map(normalize)
    results["__joinKey"]=results[result_key].map(normalize)
    candidates=project["data"]["candidates"]
    if results_format=="long":
        candidate_field=project["data"]["fields"].get("candidate") or "candidate"; votes_field=project["data"]["fields"].get("votes") or "votes"
        if candidate_field not in results or votes_field not in results: raise ValueError("Long results require mapped candidate and votes fields")
        alias={normalize(name):c["id"] for c in candidates for name in [c["displayName"],c["id"],*c.get("sourceNames",[])]}
        results["__candidateId"]=results[candidate_field].map(lambda x:alias.get(normalize(x)))
        unknown=results[results.__candidateId.isna()][candidate_field].drop_duplicates().tolist()
        if unknown: diagnostics.append({"severity":"warning","code":"UNCONFIGURED_CANDIDATES","message":f"{len(unknown)} candidate labels are not configured","count":len(unknown),"records":[{"candidate":str(x)} for x in unknown[:100]],"fix":"Add aliases or candidate definitions."})
        wide=results.dropna(subset=["__candidateId"]).pivot_table(index="__joinKey",columns="__candidateId",values=votes_field,aggfunc="sum",fill_value=0).reset_index()
        candidate_columns=[(c["id"],c["id"]) for c in candidates]
    else:
        candidate_columns=_candidate_columns(project,results,result_key)
        wide=results.groupby("__joinKey",as_index=False)[[col for _,col in candidate_columns]].sum(numeric_only=True)
    geo_keys=set(geography.__joinKey); result_keys=set(wide.__joinKey); unmatched_results=sorted(result_keys-geo_keys); unmatched_polygons=sorted(geo_keys-result_keys)
    if unmatched_results:diagnostics.append({"severity":"error","code":"UNMATCHED_RESULTS","message":f"{len(unmatched_results)} election rows do not match a polygon","count":len(unmatched_results),"records":[{"key":x} for x in unmatched_results[:200]],"fix":"Review join fields, aliases, whitespace, and county-qualified keys."})
    if unmatched_polygons:diagnostics.append({"severity":"warning","code":"UNMATCHED_POLYGONS","message":f"{len(unmatched_polygons)} polygons have no result row","count":len(unmatched_polygons),"records":[{"key":x} for x in unmatched_polygons[:200]]})
    joined=geography.merge(wide,on="__joinKey",how="left",validate="one_to_one" if not geo_dup else "many_to_one")
    records=[]
    for _,row in joined.iterrows():
        votes={}
        for cid,col in candidate_columns:
            value=pd.to_numeric(row.get(col,0),errors="coerce")
            votes[cid]=0 if pd.isna(value) else int(value)
        ordered=sorted(votes.items(),key=lambda x:(-x[1],x[0]));total=sum(votes.values()); winner=ordered[0] if ordered else None; runner=ordered[1] if len(ordered)>1 else None
        records.append({"key":row["__joinKey"],"name":str(row.get(project["data"]["fields"].get("precinctName",""),"")),"county":str(row.get(project["data"]["fields"].get("county",""),"")),"totalVotes":total,"winnerId":winner[0] if total and winner else None,"runnerUpId":runner[0] if total and runner else None,"margin":(winner[1]-(runner[1] if runner else 0))/total if total and winner else None,"values":{},"candidateVotes":votes})
    zero=sum(r["totalVotes"]==0 for r in records)
    if zero:diagnostics.append({"severity":"info","code":"NO_CANDIDATE_VOTES","message":f"{zero} polygons have no configured candidate votes","count":zero})
    keep=["__joinKey",geography_key,"geometry"]
    feature_collection=json.loads(joined[keep].to_json(drop_id=True))
    project=json.loads(json.dumps(project));project["data"]["join"].update({"resultField":result_key,"geographyField":geography_key});project["data"]["resultsFormat"]=results_format
    if coordinate_transformer:
        for element in project.get("elements",[]):
            if element.get("type") != "inset": continue
            if element.get("center"):
                element["center"]=list(coordinate_transformer.transform(*element["center"]))
            if element.get("geographicExtent"):
                x0,y0,x1,y1=element["geographicExtent"]
                corners=[coordinate_transformer.transform(x,y) for x,y in ((x0,y0),(x0,y1),(x1,y0),(x1,y1))]
                xs=[point[0] for point in corners];ys=[point[1] for point in corners]
                element["geographicExtent"]=[min(xs),min(ys),max(xs),max(ys)]
    project["renderData"]={**feature_collection,"records":records,"diagnostics":diagnostics,"bounds":[float(x) for x in joined.total_bounds],"crs":str(joined.crs),"sourceHashes":{"geography":sha256(geography_path),"results":sha256(results_path)}}
    return project
