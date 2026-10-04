from __future__ import annotations

import hashlib
import json
import math
import os
import threading
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import geopandas as gpd
import pandas as pd
from PIL import Image, features as pillow_features

STUDIO_ROOT = Path(__file__).resolve().parents[2]
ELECTION_MAPS_ROOT = Path(os.environ.get("ELECTION_MAPS_ROOT", STUDIO_ROOT)).resolve()
CATALOG_PATH = STUDIO_ROOT / "library" / "catalog.json"
TEMPLATE_PATH = STUDIO_ROOT / "public" / "templates" / "alabama_editorial.json"
EXAMPLE_PATH = STUDIO_ROOT / "public" / "examples" / "alabama_demo.pmap.json"
CACHE_ROOT = STUDIO_ROOT / ".cache" / "library"
PREVIEW_CACHE_ROOT = STUDIO_ROOT / ".cache" / "previews"
PREVIEW_DEFAULT_WIDTH = 640
PREVIEW_MIN_WIDTH = 64
PREVIEW_MAX_WIDTH = 1600
WEBP_QUALITY = 82
CACHE_SCHEMA_VERSION = 8

NAME_FIELDS = ("Precinct", "NAME17", "NAME10", "precinct")
COUNTY_FIELDS = ("County", "county", "county_fips", "COUNTYFP10", "COUNTYFP20", "COUNTYFP")
ACCEPTED_VALUES = frozenset({"true", "1", "yes", "accepted"})
SHAPEFILE_SIDECARS = (".shx", ".dbf", ".prj", ".cpg")
_WEBP_SUPPORTED = pillow_features.check("webp")

# Repeated selection of the same catalog, matched source and audit table is the
# dominant cost when the frontend switches elections, so each is parsed once per
# source revision. Caches are keyed by path plus mtime/size, so an edited file is
# never served from a stale entry.
_CATALOG_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
_HASH_CACHE: dict[tuple[str, str], str] = {}
_FRAME_CACHE: dict[tuple[str, str], gpd.GeoDataFrame] = {}
_HASH_CACHE_LIMIT = 128
_FRAME_CACHE_LIMIT = 2
_BUILD_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _file_stamp(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def _catalog_document() -> dict[str, Any]:
    key = (str(CATALOG_PATH), _file_stamp(CATALOG_PATH))
    document = _CATALOG_CACHE.get(key)
    if document is None:
        document = json.loads(CATALOG_PATH.read_text())
        _CATALOG_CACHE.clear()
        _CATALOG_CACHE[key] = document
    return document


def catalog() -> dict[str, Any]:
    data = _catalog_document()
    public=[]
    for entry in data["entries"]:
        preview = preview_path(entry)
        try:
            declared = _declared_files(entry)
        except (KeyError, ValueError):
            declared = None
        public.append({k:v for k,v in entry.items() if k not in {"path","layer","keyField","candidates","preview","results","crosswalk","provenance"}} | {
            "sourcePath": entry["path"],
            "resultsPath": (entry.get("results") or {}).get("path"),
            "crosswalkPath": (entry.get("crosswalk") or {}).get("path"),
            "provenanceFiles": [dict(item) for item in entry.get("provenance", [])],
            "previewUrl": f"/api/library/{entry['id']}/preview" if preview else None,
            "previewThumbnailUrl": f"/api/library/{entry['id']}/preview?width={PREVIEW_DEFAULT_WIDTH}" if preview else None,
            "candidateCount":len(entry["candidates"]),
            "available":declared is not None and all(path.is_file() for path in declared),
        })
    return {"schemaVersion":data["schemaVersion"],"entries":public}


def entry_by_id(entry_id: str) -> dict[str, Any]:
    entries=_catalog_document()["entries"]
    try:return deepcopy(next(entry for entry in entries if entry["id"]==entry_id))
    except StopIteration as exc:raise KeyError(entry_id) from exc


def preview_path(entry: dict[str, Any]) -> Path | None:
    """Resolve only a catalog-declared local publication preview."""
    if not entry.get("preview"):
        return None
    path = (ELECTION_MAPS_ROOT / entry["preview"]).resolve()
    if not path.is_relative_to(ELECTION_MAPS_ROOT) or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        return None
    return path if path.is_file() else None


def thumbnail_width(value: str | int | None) -> int:
    """Clamp a requested preview width to a sane, cacheable range."""
    try:
        requested=int(value)
    except (TypeError, ValueError):
        return PREVIEW_DEFAULT_WIDTH
    return max(PREVIEW_MIN_WIDTH,min(requested,PREVIEW_MAX_WIDTH))


def preview_thumbnail(entry_id: str, width: int | None=None) -> tuple[Path, str] | None:
    """Downscaled preview for library cards, cached on disk against the source revision.

    Library cards display these images a few hundred pixels wide; serving the multi-thousand-pixel
    publication raster decodes tens of megabytes per card. The published file is never modified.
    """
    entry=entry_by_id(entry_id)
    source=preview_path(entry)
    if source is None:return None
    requested=thumbnail_width(width)
    extension=".webp" if _WEBP_SUPPORTED else ".png"
    identity=hashlib.sha256(f"{source}:{_file_stamp(source)}".encode()).hexdigest()[:24]
    cached=PREVIEW_CACHE_ROOT/f"{entry_id}--{identity}--{requested}{extension}"
    if cached.is_file():return cached,"image/webp" if extension==".webp" else "image/png"
    image=_render_thumbnail(source,requested,extension)
    PREVIEW_CACHE_ROOT.mkdir(parents=True,exist_ok=True)
    staged=cached.with_name(f".{cached.name}.{uuid4().hex}.tmp")
    try:
        if extension==".webp":image.save(staged,"WEBP",quality=WEBP_QUALITY,method=4)
        else:image.save(staged,"PNG",optimize=True)
        os.replace(staged,cached)
    finally:
        image.close()
        staged.unlink(missing_ok=True)
    return cached,"image/webp" if extension==".webp" else "image/png"


def _render_thumbnail(source: Path, width: int, extension: str) -> Image.Image:
    with Image.open(source) as opened:
        opened.load()
        image=opened.convert("RGBA" if "A" in opened.getbands() or "transparency" in opened.info else "RGB") if extension==".webp" else opened.copy()
        image.thumbnail((width,width),Image.Resampling.LANCZOS)
    return image


def _relative_source(path: Path) -> str:
    return path.relative_to(ELECTION_MAPS_ROOT).as_posix()


def _workspace_path(relative: str) -> Path:
    path=(ELECTION_MAPS_ROOT/relative).resolve()
    if not path.is_relative_to(ELECTION_MAPS_ROOT):raise ValueError("Library source escapes the Election-Maps workspace")
    return path


def _source_path(entry: dict[str, Any]) -> Path:
    path=_workspace_path(entry["path"])
    if not path.exists():raise FileNotFoundError(path)
    return path


def _declared_files(entry: dict[str, Any]) -> list[Path]:
    """Every declared local input of an entry, in declaration order and without repeats."""
    relative=[entry["path"]]
    if entry.get("results"):relative.append(entry["results"]["path"])
    if entry.get("crosswalk"):relative.append(entry["crosswalk"]["path"])
    if entry.get("matchAudit"):relative.append(entry["matchAudit"])
    relative.extend(item["path"] for item in entry.get("provenance",[]))
    files: list[Path]=[]
    for item in relative:
        path=_workspace_path(item)
        # A shapefile is one dataset spread over `.shp`/`.shx`/`.dbf`/`.prj`; revision tracking and
        # hashing must cover the sidecars or an attribute-only edit would keep a stale cache.
        candidates=[path,*[path.with_suffix(extension) for extension in SHAPEFILE_SIDECARS]] if path.suffix.lower()==".shp" else [path]
        for candidate in candidates:
            if candidate in files:continue
            if candidate!=path and not candidate.is_file():continue
            files.append(candidate)
    return files


def _declared_table(entry: dict[str, Any], spec: dict[str, Any]) -> pd.DataFrame:
    path=_workspace_path(spec["path"])
    if not path.is_file():raise FileNotFoundError(path)
    identifiers={entry["keyField"]:"string",**{spec[field]:"string" for field in ("keyField","sourceField","targetField") if spec.get(field)}}
    return pd.read_csv(path,dtype=identifiers)


def _cache_path(entry: dict[str, Any], files: list[Path]) -> Path:
    stamp="\n".join([f"v{CACHE_SCHEMA_VERSION}",json.dumps(entry,sort_keys=True,separators=(",",":")),f"template:{_file_stamp(TEMPLATE_PATH)}",f"example:{_file_stamp(EXAMPLE_PATH)}",*[f"{path}:{_file_stamp(path)}" for path in files]])
    digest=hashlib.sha256(stamp.encode()).hexdigest()[:24]
    return CACHE_ROOT/f"{entry['id']}--{digest}.pmap.json"


def _write_cache(cache_path: Path, project: dict[str, Any]) -> None:
    CACHE_ROOT.mkdir(parents=True,exist_ok=True)
    staged=cache_path.with_name(f".{cache_path.name}.{uuid4().hex}.tmp")
    try:
        staged.write_text(json.dumps(project,separators=(",",":"),allow_nan=False))
        os.replace(staged,cache_path)
    finally:
        staged.unlink(missing_ok=True)
    # Do not unlink earlier revisions here: an in-flight FileResponse may still need to open one.


def _read_source(path: Path, layer: str | None) -> gpd.GeoDataFrame:
    """Parse matched geography once per revision; each caller receives its own copy."""
    parts=[path,*[path.with_suffix(extension) for extension in SHAPEFILE_SIDECARS if path.with_suffix(extension).is_file()]] if path.suffix.lower()==".shp" else [path]
    revision="|".join(f"{part}:{_file_stamp(part)}" for part in parts)
    key=(str(path),f"{layer or ''}@{revision}")
    frame=_FRAME_CACHE.get(key)
    if frame is None:
        frame=gpd.read_file(path,layer=layer)
        if len(_FRAME_CACHE)>=_FRAME_CACHE_LIMIT:_FRAME_CACHE.clear()
        _FRAME_CACHE[key]=frame
    return frame.copy()


def _file_hash(path: Path) -> str:
    key=(str(path),_file_stamp(path))
    digest=_HASH_CACHE.get(key)
    if digest is None:
        with path.open("rb") as stream:
            digest=hashlib.file_digest(stream,"sha256").hexdigest()
        if len(_HASH_CACHE)>=_HASH_CACHE_LIMIT:_HASH_CACHE.clear()
        _HASH_CACHE[key]=digest
    return digest


def _entry_lock(entry_id: str) -> threading.Lock:
    """One lock per catalog entry: concurrent requests for the same race build it once."""
    with _LOCKS_GUARD:
        return _BUILD_LOCKS.setdefault(entry_id,threading.Lock())


def _vote_value(raw: Any) -> float | int:
    if pd.isna(raw):return 0
    value=float(raw)
    if not math.isfinite(value) or value < 0:raise ValueError(f"Invalid non-finite or negative vote value: {raw!r}")
    return int(value) if value.is_integer() else value


def _record(key: str, name: str, county: str, votes: dict[str, float | int], extra: dict[str, Any] | None=None) -> dict[str, Any]:
    ordered=sorted(votes.items(),key=lambda pair:(-pair[1],pair[0]));total=sum(votes.values());winner=ordered[0] if ordered else None;runner=ordered[1] if len(ordered)>1 else None
    record={"key":key,"name":name,"county":county,"totalVotes":total,"values":{},"candidateVotes":votes}
    if total and winner:
        record["winnerId"]=winner[0]
        record["margin"]=(winner[1]-(runner[1] if runner else 0))/total
        if runner:record["runnerUpId"]=runner[0]
    if extra:record.update(extra)
    return record


def _feature_records(geography: gpd.GeoDataFrame, entry: dict[str, Any], name_field: str | None, county_field: str | None, votes_by_key: dict[str, list[Any]] | None) -> list[dict[str, Any]]:
    """Turn each drawable precinct into a vote record, reading votes from the results table when declared."""
    candidates=[(candidate["id"],candidate["column"]) for candidate in entry["candidates"]]
    join_keys=geography["__joinKey"].tolist()
    names=geography[name_field].tolist() if name_field else [""]*len(join_keys)
    counties=geography[county_field].tolist() if county_field else [""]*len(join_keys)
    embedded=None if votes_by_key is not None else {column:pd.to_numeric(geography[column],errors="raise").tolist() for _,column in candidates}
    empty=[0.0]*len(candidates)
    records=[]
    for index,key in enumerate(join_keys):
        raw=votes_by_key.get(key,empty) if votes_by_key is not None else [embedded[column][index] for _,column in candidates]
        votes={candidate_id:_vote_value(value) for (candidate_id,_),value in zip(candidates,raw)}
        records.append(_record(key,str(names[index]),str(counties[index]) if county_field else "",votes))
    return records


def _accepted_mask(table: pd.DataFrame, entry: dict[str, Any], spec: dict[str, Any]) -> pd.Series:
    field=spec.get("acceptedField")
    if not field:return pd.Series(True,index=table.index)
    if field not in table.columns:raise ValueError(f"Library entry {entry['id']} crosswalk is missing accepted field: {field}")
    values={str(value).strip().lower() for value in spec.get("acceptedValues",ACCEPTED_VALUES)}
    return table[field].astype(str).str.strip().str.lower().isin(values)


def _results_votes(entry: dict[str, Any], geometry_keys: set[str]) -> tuple[dict[str, list[Any]], list[dict[str, Any]], dict[str, Any]]:
    """Resolve catalog-declared processed results onto geometry keys without re-running any match.

    Results are joined verbatim on the declared geometry key; a results record whose key has no
    geometry is returned as an unmatched vote record instead of being dropped.
    """
    spec=entry["results"]
    table=_declared_table(entry,spec)
    key_field=spec.get("keyField",entry["keyField"])
    if key_field!=entry["keyField"]:
        raise ValueError(f"Library entry {entry['id']} declares results key {key_field} but geometry key {entry['keyField']}; matched results must already carry the geometry key")
    if key_field not in table.columns:raise ValueError(f"Library entry {entry['id']} results are missing key field: {key_field}")
    candidates=[(candidate["id"],candidate["column"]) for candidate in entry["candidates"]]
    missing=[column for _,column in candidates if column not in table.columns]
    if missing:raise ValueError(f"Library entry {entry['id']} results are missing fields: {', '.join(missing)}")
    if table[key_field].isna().any():raise ValueError("Matched results require non-null keys")
    source_keys=table[key_field].astype(str).tolist()
    if len(set(source_keys))!=len(source_keys):
        raise ValueError(f"Library entry {entry['id']} results repeat keys; refusing to double-count votes")
    values={column:pd.to_numeric(table[column],errors="raise").tolist() for _,column in candidates}
    name_field=spec.get("nameField") or next((field for field in NAME_FIELDS if field in table.columns),None)
    county_field=spec.get("countyField") or next((field for field in COUNTY_FIELDS if field in table.columns),None)
    for field in (name_field,county_field):
        if field and field not in table.columns:raise ValueError(f"Library entry {entry['id']} results are missing label field: {field}")
    names=table[name_field].tolist() if name_field else [""]*len(source_keys)
    counties=table[county_field].tolist() if county_field else [""]*len(source_keys)
    votes_by_key: dict[str, list[Any]]={}
    unmatched=[]
    keys_seen: dict[str,int]={}
    for index,source in enumerate(source_keys):
        row=[values[column][index] for _,column in candidates]
        if source not in geometry_keys:
            unmatched.append(_unmatched_record(entry,keys_seen,source,names[index],counties[index],row))
            continue
        votes_by_key[source]=row
    stats={"path":spec["path"],"rows":len(table),"joined":len(votes_by_key),"unmatched":len(unmatched)}
    return votes_by_key,unmatched,stats


def _unmatched_record(entry: dict[str, Any], keys_seen: dict[str,int], label: str, name: Any, county: Any, row: list[Any]) -> dict[str, Any]:
    base=f"unmatched:{label}"
    seen=keys_seen.get(base,0)+1;keys_seen[base]=seen
    votes={candidate["id"]:_vote_value(value) for candidate,value in zip(entry["candidates"],row)}
    return _record(base if seen==1 else f"{base}#{seen}",str(name),str(county),votes,{"unmatchedSource":True,"sourceKey":label})


def _crosswalk_audit(entry: dict[str, Any], mapped_totals: dict[str, float | int] | None) -> tuple[list[dict[str, Any]], dict[str, Any] | None, dict[str, Any] | None]:
    """Summarize the declared crosswalk and preserve the source units it left unassigned.

    Accepted crosswalk rows describe matching that is already materialized in the geometry, so they
    are never summed into it. Rows the crosswalk itself did not accept are the only ones that can
    hold votes with no geometry, and those are returned as unmatched records.
    """
    spec=entry.get("crosswalk")
    if not spec:return [],None,None
    table=_declared_table(entry,spec)
    accepted=_accepted_mask(table,entry,spec)
    summary={"path":spec["path"],"rows":int(len(table)),"accepted":int(accepted.sum()),"unmatched":int((~accepted).sum())}
    for field,label in ((spec.get("methodField"),"methods"),(spec.get("confidenceField"),"confidence"),(spec.get("relationshipField"),"relationships")):
        if field and field in table.columns:summary[label]={str(key):int(value) for key,value in table[field].value_counts().items()}
    vote_fields=spec.get("voteFields")
    if not vote_fields:return [],summary,None
    columns={candidate["id"]:(vote_fields.get(candidate["id"]) or candidate["column"]) for candidate in entry["candidates"]}
    missing=[column for column in columns.values() if column not in table.columns]
    if missing:raise ValueError(f"Library entry {entry['id']} crosswalk is missing vote fields: {', '.join(missing)}")
    name_field=spec.get("nameField") or next((field for field in ("source_precinct","Precinct","precinct") if field in table.columns),None)
    county_field=spec.get("countyField") or next((field for field in COUNTY_FIELDS if field in table.columns),None)
    for field in (name_field,county_field):
        if field and field not in table.columns:raise ValueError(f"Library entry {entry['id']} crosswalk is missing label field: {field}")
    names=table[name_field].tolist() if name_field else [""]*len(table)
    counties=table[county_field].tolist() if county_field else [""]*len(table)
    series={candidate_id:pd.to_numeric(table[column],errors="raise").tolist() for candidate_id,column in columns.items()}
    records=[];keys_seen: dict[str,int]={}
    unmatched_totals={candidate_id:0 for candidate_id in columns};accepted_totals={candidate_id:0 for candidate_id in columns}
    kept=accepted.tolist()
    for index in range(len(table)):
        row=[_vote_value(series[candidate_id][index]) for candidate_id in columns]
        target=accepted_totals if kept[index] else unmatched_totals
        for candidate_id,value in zip(columns,row):
            target[candidate_id]+=value
        if kept[index]:continue
        source=names[index]
        label=str(source) if source is not None and not pd.isna(source) else str(table.index[index])
        records.append(_unmatched_record(entry,keys_seen,label,names[index],counties[index],row))
    summary["acceptedVotes"]=accepted_totals
    summary["unmatchedVotes"]=unmatched_totals
    reconciliation={"acceptedVotes":accepted_totals,"unmatchedVotes":unmatched_totals}
    if mapped_totals is not None:
        deltas={candidate_id:accepted_totals[candidate_id]-float(mapped_totals.get(candidate_id,0)) for candidate_id in accepted_totals}
        reconciliation["geometryVotes"]={candidate_id:mapped_totals.get(candidate_id,0) for candidate_id in accepted_totals}
        reconciliation["deltas"]=deltas
        if any(abs(value)>0.5 for value in deltas.values()):
            summary["geometryMismatch"]=deltas
    return records,summary,reconciliation


def _totals(records: list[dict[str, Any]], candidate_ids: list[str]) -> dict[str, float | int]:
    return {candidate_id:sum(record["candidateVotes"][candidate_id] for record in records) for candidate_id in candidate_ids}


def _county_boundaries(geography: gpd.GeoDataFrame, county_field: str | None, invalid: int) -> tuple[dict[str, Any] | None, str | None]:
    """Dissolve county outlines from the matched precincts, in the source CRS.

    Returns the outlines in EPSG:4326, or the reason they could not be built. A precinct layer with
    invalid geometry is never dissolved, because a union would invent boundaries.
    """
    if not county_field:return None,None
    if invalid:return None,f"{invalid} invalid source geometries are retained unchanged; county outlines are unavailable for this dataset."
    usable=geography.loc[geography.geometry.notna() & ~geography.geometry.is_empty & geography[county_field].notna(), [county_field, "geometry"]]
    if usable.empty:return None,None
    try:
        counties=usable.dissolve(by=county_field)
    except Exception as exc:
        return None,f"County outlines could not be dissolved from the source precincts ({type(exc).__name__}); precinct geometry is unaffected."
    return json.loads(counties.to_crs(4326).to_json(drop_id=True)),None


def _materialize(entry: dict[str, Any], cache_path: Path, declared: list[Path], use_cache: bool=True) -> Path:
    """Build the project once, write the cache, and return the cache path.

    Serialized once here so the HTTP layer can serve the file without ever parsing or re-encoding
    it, and so a second concurrent request for the same entry reuses this result.
    """
    with _entry_lock(entry["id"]):
        if use_cache and cache_path.exists():return cache_path
        _write_cache(cache_path,_build_project(entry,declared))
    return cache_path


def build_project(entry_id: str, use_cache: bool=True) -> dict[str, Any]:
    """Materialized project for an entry. A cached project is reused unless `use_cache` is False."""
    entry=entry_by_id(entry_id)
    declared=_declared_files(entry);cache_path=_cache_path(entry,declared)
    if use_cache and cache_path.exists():return json.loads(cache_path.read_text())
    return json.loads(_materialize(entry,cache_path,declared,use_cache).read_text())


def cached_project(entry_id: str) -> Path:
    """Path of the serialized project for an entry, building it only when the cache is stale."""
    entry=entry_by_id(entry_id)
    declared=_declared_files(entry);cache_path=_cache_path(entry,declared)
    return cache_path if cache_path.exists() else _materialize(entry,cache_path,declared)


def _build_project(entry: dict[str, Any], declared: list[Path]) -> dict[str, Any]:
    entry_id=entry["id"]
    source=_source_path(entry)
    geography=_read_source(source,entry.get("layer"))
    key_field=entry["keyField"]
    results_spec=entry.get("results")
    required=[key_field] if results_spec else [key_field,*[candidate["column"] for candidate in entry["candidates"]]]
    missing=[field for field in required if field not in geography.columns]
    if missing:raise ValueError(f"Library entry {entry_id} is missing fields: {', '.join(missing)}")
    if geography.crs is None:
        raise ValueError("Matched geography must declare its CRS; the editor never guesses coordinates")
    keys = geography[key_field]
    if keys.isna().any() or keys.astype(str).duplicated().any():
        raise ValueError("Matched geography requires non-null, unique precinct keys")
    missing_geometry = int((geography.geometry.isna() | geography.geometry.is_empty).sum())
    invalid=int((~geography.geometry.is_valid & geography.geometry.notna()).sum())
    original_crs=str(geography.crs)
    name_field=next((field for field in NAME_FIELDS if field in geography.columns),None)
    county_field = next((field for field in COUNTY_FIELDS if field in geography.columns), None)
    # County outlines are dissolved before reprojection: transforming first can break shared edges
    # into self-intersections, which fails the union even though every source polygon is valid.
    county_boundaries,county_error = _county_boundaries(geography,county_field,invalid)
    if geography.crs.to_epsg() != 4326:
        geography=geography.to_crs(4326)
    geography["__joinKey"]=geography[key_field].astype(str)
    candidate_ids=[candidate["id"] for candidate in entry["candidates"]]
    votes_by_key=None;unmatched_records=[];results_stats=None
    if results_spec:
        votes_by_key,unmatched_records,results_stats=_results_votes(entry,set(geography["__joinKey"].tolist()))
    records=_feature_records(geography,entry,name_field,county_field,votes_by_key)
    allocated_totals=_totals(records,candidate_ids)
    drawable_keys=set(geography.loc[geography.geometry.notna() & ~geography.geometry.is_empty,"__joinKey"])
    mapped_totals=_totals([record for record in records if record["key"] in drawable_keys],candidate_ids)
    crosswalk_records,crosswalk_summary,crosswalk_reconciliation=_crosswalk_audit(entry,allocated_totals)
    if crosswalk_records and unmatched_records:
        raise ValueError("Both results and crosswalk contain unallocated votes; declare one residual source to avoid double-counting")
    used_keys={record["key"] for record in records}
    for pending in (crosswalk_records,unmatched_records):
        for record in pending:
            base=record["key"];suffix=2
            while record["key"] in used_keys:
                record["key"]=f"{base}#{suffix}";suffix+=1
            used_keys.add(record["key"])
            records.append(record)
    geometry_without_results=[] if votes_by_key is None else [key for key in geography["__joinKey"].tolist() if key not in votes_by_key]
    if county_field:
        geography["__county"] = geography[county_field].fillna("").astype(str)
    keep=["__joinKey",entry["keyField"],"geometry"] + (["__county"] if county_field else [])
    features=json.loads(geography[keep].to_json(drop_id=True))
    project=json.loads(EXAMPLE_PATH.read_text());template=json.loads(TEMPLATE_PATH.read_text())
    project.update({"id":entry["id"],"name":f"{entry['state']} {entry['year']} {entry['race']}","modifiedAt":datetime.fromtimestamp(source.stat().st_mtime, timezone.utc).isoformat()})
    source_hash=_file_hash(source)
    hashes={entry["path"]:source_hash}
    for path in declared[1:]:hashes[_relative_source(path)]=_file_hash(path)
    provenance=[{"path":item["path"],"role":item.get("role","audit"),"sha256":hashes.get(item["path"]) or _file_hash(_workspace_path(item["path"]))} for item in entry.get("provenance",[])]
    project["dataset"] = {
        "id": entry["id"], "label": project["name"], "sourcePath": entry["path"],
        "matchStatus": entry["matchStatus"], "geometryVintage": entry["geometryVintage"],
        "sourceHash": source_hash,
    }
    if entry.get("matchAudit"):
        project["dataset"]["matchAudit"] = entry["matchAudit"]
    if entry.get("matchMethod"):
        project["dataset"]["matchMethod"] = entry["matchMethod"]
    if results_spec:
        project["dataset"]["resultsPath"] = results_spec["path"]
    if entry.get("crosswalk"):
        project["dataset"]["crosswalkPath"] = entry["crosswalk"]["path"]
    if provenance:
        project["dataset"]["provenance"] = provenance
    project["metadata"]={"title":f"{entry['state']} {entry['race']} by {entry['geographyLevel']}","subtitle":f"Precinct winner and winner-over-runner-up margin · {entry['date']}","office":entry["race"],"electionDate":entry["date"],"electionType":entry["election"],"jurisdiction":entry["state"],"source":entry["source"],"notes":[f"Match status: {entry['matchStatus']}",f"Geometry vintage: {entry['geometryVintage']}"]}
    if entry.get("matchMethod"):project["metadata"]["notes"].append(f"Matching method: {entry['matchMethod']}")
    project["data"]["candidates"]=[{"id":candidate["id"],"sourceNames":[candidate["column"]],"displayName":candidate["displayName"],"shortName":candidate.get("shortName"),"color":candidate["color"],"lightColor":candidate.get("lightColor"),"darkColor":candidate.get("darkColor"),"visible":True,"order":index,"metadata":{"sourceColumn":candidate["column"]}} for index,candidate in enumerate(entry["candidates"])]
    project["data"]["candidates"] = [
        {key: value for key, value in candidate.items() if value is not None}
        for candidate in project["data"]["candidates"]
    ]
    project["data"]["join"]={"resultField":key_field,"geographyField":key_field};project["data"]["geographyPath"]=str(source);project["data"]["resultsPath"]=str(source if results_spec is None else _workspace_path(results_spec["path"]))
    elements=deepcopy(template["elements"])
    for element in elements:
        if element["type"]=="map":element["projection"]={"type":"identity"}
        if element["type"]=="header":
            element["kicker"]="{{metadata.jurisdiction}} · {{year}}"
            element["identifier"]="{{metadata.electionType}}"
        if element["type"]=="results":
            element["officeTitle"]="{{metadata.office}}"
            element["electionLabel"]="{{metadata.electionType}} · {{year}}"
    if entry["stateCode"]=="AL":
        extents={"HUNTSVILLE":[-87.10,34.30,-86.15,35.05],"BIRMINGHAM":[-87.30,33.05,-86.35,33.80],"MONTGOMERY":[-86.75,31.90,-85.80,32.65],"MOBILE":[-88.55,30.20,-87.60,30.95]}
        for element in elements:
            if element["type"]=="inset":element["geographicExtent"]=extents[element["label"]];element["center"]=[(extents[element["label"]][0]+extents[element["label"]][2])/2,(extents[element["label"]][1]+extents[element["label"]][3])/2]
    else:
        elements=[element for element in elements if element["type"]!="inset"]
        for element in elements:
            if element["type"]=="map":element["frame"]={"x":36,"y":198,"width":850,"height":900}
            if element["type"]=="results":element["frame"]={"x":910,"y":202,"width":462,"height":430}
    project["elements"]=elements
    diagnostics=[{"severity":"info","code":"LIBRARY_MATCH_PROVENANCE","message":f"Pre-matched library project: {entry['matchStatus']}","fix":"Review the source and match audit before using the data for inference."}]
    if entry.get("matchMethod"):diagnostics.append({"severity":"info","code":"LIBRARY_MATCH_METHOD","message":f"Matching method: {entry['matchMethod']}"})
    if invalid:
        diagnostics.append({"severity":"warning","code":"INVALID_SOURCE_GEOMETRY","message":f"{invalid} invalid source geometries are retained unchanged; repair upstream if needed. County outlines are unavailable for this dataset.","count":invalid})
    elif county_error:
        diagnostics.append({"severity":"warning","code":"COUNTY_OUTLINES_UNAVAILABLE","message":county_error})
    if missing_geometry:
        diagnostics.append({"severity":"warning","code":"MISSING_GEOMETRY","message":f"{missing_geometry} precinct records have no drawable geometry; votes are retained in totals","count":missing_geometry})
    zero=sum(record["totalVotes"]==0 for record in records)
    if zero:diagnostics.append({"severity":"info","code":"NO_CANDIDATE_VOTES","message":f"{zero} polygons have no configured candidate votes","count":zero})
    undrawn=crosswalk_records+unmatched_records
    if undrawn:
        votes=_totals(undrawn,candidate_ids)
        with_votes=sum(1 for record in undrawn if record["totalVotes"])
        diagnostics.append({"severity":"warning","code":"UNMATCHED_SOURCE_RECORDS",
            "message":f"{len(undrawn)} matched source records have no geometry in this dataset; {with_votes} carry votes that stay in the totals but cannot be drawn. Vote totals: {json.dumps(votes,separators=(',',':'))}",
            "count":len(undrawn),
            "fix":entry.get("unmatchedFix") or "Review the declared crosswalk audit and assign or document these source records upstream; the editor never re-matches names.",
            "records":[{"key":record["key"],"name":record["name"],"county":record["county"],"totalVotes":record["totalVotes"]} for record in undrawn]})
    if geometry_without_results:
        diagnostics.append({"severity":"info","code":"GEOMETRY_WITHOUT_RESULTS",
            "message":f"{len(geometry_without_results)} geometry units have no row in the declared results table and carry no votes",
            "count":len(geometry_without_results),
            "records":[{"key":key} for key in geometry_without_results]})
    if crosswalk_reconciliation and crosswalk_reconciliation.get("deltas"):
        deltas=crosswalk_reconciliation["deltas"]
        if any(abs(value)>0.5 for value in deltas.values()):
            diagnostics.append({"severity":"warning","code":"CROSSWALK_VOTE_MISMATCH","message":f"Accepted crosswalk rows and mapped geometry votes disagree: {json.dumps(deltas,separators=(',',':'))}","records":[{"candidate":candidate_id,"accepted":crosswalk_reconciliation['acceptedVotes'][candidate_id],"mapped":crosswalk_reconciliation['geometryVotes'].get(candidate_id)} for candidate_id in deltas]})
    reconciliation=None
    source_totals=entry.get("sourceTotals")
    if source_totals:
        preserved=_totals(records,candidate_ids)
        unmatched_totals=_totals([record for record in records if record["key"] not in drawable_keys],candidate_ids)
        source_label=entry.get("sourceTotalsLabel","Declared source totals")
        reconciliation={"source":source_totals,"mapped":mapped_totals,"unmatched":unmatched_totals,"preserved":preserved,
            "coverage":{candidate_id:round(float(mapped_totals.get(candidate_id,0))/value,4) if value else None for candidate_id,value in source_totals.items()},
            "note":entry.get("sourceTotalsNote"),"sourceLabel":source_label}
        over=[candidate_id for candidate_id,value in source_totals.items() if preserved.get(candidate_id,0) > value]
        incomplete=bool(entry.get("incompleteElection")) or any(preserved.get(candidate_id,0) < value for candidate_id,value in source_totals.items())
        reconciliation["incompleteElection"]=incomplete
        if incomplete:project["metadata"]["subtitle"] += " · recovered precinct returns"
        if entry.get("sourceTotalsNote"):project["metadata"]["notes"].append(entry["sourceTotalsNote"])
        diagnostics.append({"severity":"warning" if over or incomplete else "info","code":"SOURCE_TOTAL_RECONCILIATION",
            "message":f"Drawn precinct totals cover {json.dumps(reconciliation['coverage'],separators=(',',':'))} of {source_label}; preserved records hold {json.dumps(preserved,separators=(',',':'))}. {entry.get('sourceTotalsNote') or ''}".strip(),
            "records":[{"candidate":candidate_id,"mapped":mapped_totals.get(candidate_id,0),"preserved":preserved.get(candidate_id,0),"source":value,"coverage":reconciliation['coverage'][candidate_id]} for candidate_id,value in source_totals.items()],
            "fix":"Absentee, provisional or otherwise unassignable ballots are excluded from precinct geometry upstream." if not over else "Preserved votes exceed the declared source totals; verify the results and crosswalk before publishing."})
    library={"entryId":entry["id"],"matchStatus":entry["matchStatus"],"geometryVintage":entry["geometryVintage"],"originalCrs":original_crs,"matchAudit":entry.get("matchAudit")}
    if entry.get("matchMethod"):library["matchMethod"]=entry["matchMethod"]
    if results_stats:library["results"]=results_stats
    if crosswalk_summary:library["crosswalk"]=crosswalk_summary
    if undrawn:library["unmatched"]={"records":len(undrawn),"withVotes":sum(1 for record in undrawn if record["totalVotes"]),"voteTotals":_totals(undrawn,candidate_ids),"fromResults":len(unmatched_records),"fromCrosswalk":len(crosswalk_records)}
    if geometry_without_results:library["geometryWithoutResults"]={"count":len(geometry_without_results),"keys":geometry_without_results}
    if reconciliation:library["reconciliation"]=reconciliation
    if provenance:library["provenance"]=provenance
    project["renderData"]={**features,"records":records,"diagnostics":diagnostics,"bounds":[float(value) for value in geography.total_bounds],"crs":"EPSG:4326","sourceHashes":hashes,"library":library}
    if missing_geometry == len(geography):
        project["renderData"].pop("bounds", None)
    if county_boundaries is not None:
        project["renderData"]["countyBoundaries"] = county_boundaries
    return project




def warm_cache() -> list[dict[str, Any]]:
    results=[]
    for item in catalog()["entries"]:
        if not item["available"]:results.append({"id":item["id"],"status":"missing"});continue
        render=build_project(item["id"])["renderData"];library=render.get("library",{})
        results.append({"id":item["id"],"status":"ready","features":len(render["features"]),"records":len(render["records"]),"unmatched":library.get("unmatched",{}).get("records",0)})
    return results
