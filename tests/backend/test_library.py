import pytest

from political_map_studio.library import build_project, catalog


@pytest.mark.skipif(
    not {"pa-2026-hd12-special", "al-2006-agriculture-commissioner"}.issubset(
        {entry["id"] for entry in catalog()["entries"]}
    ) or not all(entry["available"] for entry in catalog()["entries"]),
    reason="Requires the external Election-Maps archive catalog and source datasets",
)
def test_library_catalog_sources_are_available():
    entries=catalog()["entries"]
    assert {entry["stateCode"] for entry in entries}>={"AL","PA","TN"}
    assert all(entry["available"] for entry in entries)


@pytest.mark.skipif(
    not {"pa-2026-hd12-special", "al-2006-agriculture-commissioner"}.issubset(
        {entry["id"] for entry in catalog()["entries"]}
    ) or not all(entry["available"] for entry in catalog()["entries"]),
    reason="Requires the external Election-Maps archive catalog and source datasets",
)
def test_small_library_project_has_matched_totals_and_provenance():
    project=build_project("pa-2026-hd12-special",use_cache=False)
    assert len(project["renderData"]["features"])==27
    totals={candidate["id"]:sum(record["candidateVotes"][candidate["id"]] for record in project["renderData"]["records"]) for candidate in project["data"]["candidates"]}
    assert totals=={"dukes":8434,"timko":8346,"write-in":35}
    assert project["renderData"]["library"]["matchStatus"]=="source-integrated"
    assert project["metadata"]["jurisdiction"]=="Pennsylvania"


def test_library_preserves_votes_without_drawable_geometry(tmp_path, monkeypatch):
    import json
    import hashlib
    import geopandas as gpd
    from shapely.geometry import box
    from political_map_studio import library

    source = tmp_path / "matched.gpkg"
    gpd.GeoDataFrame(
        {"precinct_id": ["mapped", "missing"], "a": [10, 30], "b": [20, 40]},
        geometry=[box(-80, 40, -79, 41), None], crs=4326,
    ).to_file(source, layer="results", driver="GPKG")
    entry = {
        "id": "coverage", "path": source.name, "layer": "results", "keyField": "precinct_id",
        "state": "Pennsylvania", "stateCode": "PA", "year": 2026,
        "race": "Coverage fixture", "office": "TEST", "election": "General",
        "date": "2026-11-03", "geographyLevel": "Precinct", "source": "Fixture",
        "geometryVintage": "2026", "matchStatus": "source-integrated",
        "sourceTotals": {"a": 40, "b": 60},
        "candidates": [
            {"id": "a", "column": "a", "displayName": "A", "color": "#0000ff"},
            {"id": "b", "column": "b", "displayName": "B", "color": "#ff0000"},
        ],
    }
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps({"schemaVersion": 1, "entries": [entry]}))
    monkeypatch.setattr(library, "ELECTION_MAPS_ROOT", tmp_path)
    monkeypatch.setattr(library, "CATALOG_PATH", catalog_path)
    monkeypatch.setattr(library, "CACHE_ROOT", tmp_path / "cache")

    project = library.build_project("coverage", use_cache=False)
    records = project["renderData"]["records"]
    assert {r["key"]: r["totalVotes"] for r in records} == {"mapped": 30, "missing": 70}
    assert len(project["renderData"]["features"]) == 2
    assert any(d["code"] == "MISSING_GEOMETRY" and d["count"] == 1 for d in project["renderData"]["diagnostics"])
    reconciliation = project["renderData"]["library"]["reconciliation"]
    assert reconciliation["mapped"] == {"a": 10, "b": 20}
    assert reconciliation["unmatched"] == {"a": 30, "b": 40}
    assert reconciliation["preserved"] == {"a": 40, "b": 60}
    expected_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    assert project["dataset"]["sourceHash"] == expected_hash
    assert project["renderData"]["sourceHashes"][source.name] == expected_hash


def test_publication_preview_cannot_escape_workspace(tmp_path, monkeypatch):
    from political_map_studio import library

    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "private.png"
    outside.write_bytes(b"not a public preview")
    monkeypatch.setattr(library, "ELECTION_MAPS_ROOT", root)
    assert library.preview_path({"preview": "../private.png"}) is None
    (root / "linked.png").symlink_to(outside)
    assert library.preview_path({"preview": "linked.png"}) is None


def _fixture_catalog(tmp_path, monkeypatch, entry, name="catalog.json"):
    """Point the library at a self-contained fixture workspace."""
    import json
    from political_map_studio import library

    catalog_path = tmp_path / name
    catalog_path.write_text(json.dumps({"schemaVersion": 1, "entries": [entry]}))
    monkeypatch.setattr(library, "ELECTION_MAPS_ROOT", tmp_path)
    monkeypatch.setattr(library, "CATALOG_PATH", catalog_path)
    monkeypatch.setattr(library, "CACHE_ROOT", tmp_path / "cache")
    monkeypatch.setattr(library, "PREVIEW_CACHE_ROOT", tmp_path / "previews")
    return library


def _fixture_entry(source, candidates, **extra):
    return {
        "id": "fixture", "path": source.name, "layer": "results", "keyField": "precinct_id",
        "state": "Alabama", "stateCode": "AL", "year": 2026,
        "race": "Fixture race", "office": "TEST", "election": "General",
        "date": "2026-11-03", "geographyLevel": "Precinct", "source": "Fixture",
        "geometryVintage": "fixture geography", "matchStatus": "reviewed-crosswalk",
        "candidates": candidates,
    } | extra




@pytest.mark.skipif(
    not {"pa-2026-hd12-special", "al-2006-agriculture-commissioner"}.issubset(
        {entry["id"] for entry in catalog()["entries"]}
    ) or not all(entry["available"] for entry in catalog()["entries"]),
    reason="Requires the external Election-Maps archive catalog and source datasets",
)
def test_crosswalk_entries_preserve_unmatched_source_votes():
    """Rejected crosswalk rows keep their votes as records without geometry instead of disappearing."""
    project=build_project("al-2006-agriculture-commissioner",use_cache=False)
    render=project["renderData"];library_block=render["library"]
    features={feature["properties"]["__joinKey"] for feature in render["features"]}
    unmatched=[record for record in render["records"] if record.get("unmatchedSource")]
    assert library_block["unmatched"]["records"]==13
    assert library_block["unmatched"]["voteTotals"]=={"sparks":3617,"lipscomb":3053}
    assert {record["key"] for record in unmatched}.isdisjoint(features)
    assert sum(record["candidateVotes"]["sparks"] for record in unmatched)==3617
    diagnostic=next(item for item in render["diagnostics"] if item["code"]=="UNMATCHED_SOURCE_RECORDS")
    assert diagnostic["count"]==13 and len(diagnostic["records"])==13
    reconciliation=library_block["reconciliation"]
    assert reconciliation["preserved"]=={"sparks":681835.0,"lipscomb":472322.0}
    assert reconciliation["mapped"]["sparks"]+reconciliation["unmatched"]["sparks"]==681835.0
    assert reconciliation["coverage"]["sparks"]==0.9947


def test_results_entry_resolves_geometry_and_keeps_orphan_return(tmp_path, monkeypatch):
    """Textual geometry keys keep leading zeroes; orphan votes are retained without re-matching."""
    import hashlib
    import geopandas as gpd
    from shapely.geometry import box

    source=tmp_path / "geometry.gpkg"
    gpd.GeoDataFrame(
        {"precinct_id":["001","002","unmatched:003"],"a":[0,0,0],"b":[0,0,0]},
        geometry=[box(-86,32,-85,33),box(-85,32,-84,33),box(-84,32,-83,33)],crs=4326,
    ).to_file(source,layer="results",driver="GPKG")
    results=tmp_path / "published-results.csv"
    results.write_text("precinct_id,a,b,Precinct,County\n001,7,9,Mapped,Marengo\n003,30,40,Orphan Return,Baldwin\n")
    audit=tmp_path / "crosswalk-audit.csv"
    audit.write_text("source_precinct,geometry_precinct,method,confidence,accepted\nOrphan Return,Orphan Return,unresolved,unresolved,False\n")
    entry=_fixture_entry(source,[
        {"id":"a","column":"a","displayName":"A","color":"#0000ff"},
        {"id":"b","column":"b","displayName":"B","color":"#ff0000"},
    ],results={"path":results.name},crosswalk={
        "path":audit.name,"sourceField":"source_precinct","targetField":"geometry_precinct",
        "acceptedField":"accepted","acceptedValues":["True"],
    })
    library=_fixture_catalog(tmp_path,monkeypatch,entry)
    project=library.build_project("fixture",use_cache=False)
    render=project["renderData"]
    by_key={record["key"]:record for record in render["records"]}
    assert by_key["001"]["candidateVotes"]=={"a":7,"b":9}
    assert by_key["002"]["totalVotes"]==0
    orphan=next(record for record in render["records"] if record.get("unmatchedSource"))
    assert orphan["sourceKey"]=="003" and orphan["candidateVotes"]=={"a":30,"b":40}
    assert orphan["key"] not in {feature["properties"]["__joinKey"] for feature in render["features"]}
    assert by_key["unmatched:003"]["totalVotes"]==0
    assert orphan["totalVotes"]==70
    assert set(render["library"]["geometryWithoutResults"]["keys"])=={"002","unmatched:003"}
    assert render["library"]["unmatched"]["voteTotals"]=={"a":30,"b":40}
    hashes=render["sourceHashes"]
    for path in (source,results,audit):
        assert hashes[path.name] == hashlib.sha256(path.read_bytes()).hexdigest()


def test_results_entry_refuses_duplicate_geometry_keys(tmp_path, monkeypatch):
    """Repeated keys would silently double-count votes, so the entry must fail instead."""
    import pytest
    import geopandas as gpd
    from shapely.geometry import box

    source=tmp_path / "geometry.gpkg"
    gpd.GeoDataFrame({"precinct_id":["one"],"a":[0]},geometry=[box(-86,32,-85,33)],crs=4326).to_file(source,layer="results",driver="GPKG")
    results=tmp_path / "dupes.csv"
    results.write_text("precinct_id,a\none,5\none,6\n")
    entry=_fixture_entry(source,[{"id":"a","column":"a","displayName":"A","color":"#0000ff"}],results={"path":results.name})
    library=_fixture_catalog(tmp_path,monkeypatch,entry)
    with pytest.raises(ValueError,match="repeat"):
        library.build_project("fixture",use_cache=False)


def test_results_entry_rejects_non_geometry_key(tmp_path, monkeypatch):
    """Published results must already carry the geometry key; the loader never guesses a join."""
    import pytest
    import geopandas as gpd
    from shapely.geometry import box

    source=tmp_path / "geometry.gpkg"
    gpd.GeoDataFrame({"precinct_id":["one"],"a":[0]},geometry=[box(-86,32,-85,33)],crs=4326).to_file(source,layer="results",driver="GPKG")
    results=tmp_path / "results.csv"
    results.write_text("SOURCE_KEY,a\none,5\n")
    entry=_fixture_entry(source,[{"id":"a","column":"a","displayName":"A","color":"#0000ff"}],
                         results={"path":results.name,"keyField":"SOURCE_KEY"})
    library=_fixture_catalog(tmp_path,monkeypatch,entry)
    with pytest.raises(ValueError,match="geometry key"):
        library.build_project("fixture",use_cache=False)


def test_results_reject_malformed_votes_instead_of_converting_them_to_zero(tmp_path, monkeypatch):
    import pytest
    import geopandas as gpd
    from shapely.geometry import box

    source=tmp_path / "geometry.gpkg"
    gpd.GeoDataFrame({"precinct_id":["one"]},geometry=[box(-86,32,-85,33)],crs=4326).to_file(source,layer="results",driver="GPKG")
    results=tmp_path / "results.csv"
    results.write_text("precinct_id,a\none,not-a-vote\n")
    entry=_fixture_entry(source,[{"id":"a","column":"a","displayName":"A","color":"#0000ff"}],results={"path":results.name})
    library=_fixture_catalog(tmp_path,monkeypatch,entry)
    with pytest.raises(ValueError):
        library.build_project("fixture",use_cache=False)


def test_crosswalk_geometry_mismatch_is_reported(tmp_path, monkeypatch):
    """Accepted crosswalk totals that disagree with the geometry votes are surfaced, not hidden."""
    import geopandas as gpd
    from shapely.geometry import box

    source=tmp_path / "geometry.gpkg"
    gpd.GeoDataFrame({"precinct_id":["vtd1"],"yes":[11],"no":[5]},geometry=[box(-86,32,-85,33)],crs=4326).to_file(source,layer="results",driver="GPKG")
    audit=tmp_path / "audit.csv"
    audit.write_text("source_precinct,target_geoid,method,confidence,relationship,accepted,yes,no\n"
                     "Box A,vtd1,exact-code,high,one-to-one,True,6,3\n"
                     "Box B,vtd1,exact-code,high,one-to-one,True,5,2\n"
                     "Box C,,unresolved,unresolved,unresolved,False,4,1\n")
    entry=_fixture_entry(source,[
        {"id":"yes","column":"yes","displayName":"Yes","color":"#0000ff"},
        {"id":"no","column":"no","displayName":"No","color":"#ff0000"},
    ],crosswalk={"path":audit.name,"sourceField":"source_precinct","targetField":"target_geoid",
                 "acceptedField":"accepted","acceptedValues":["True"],"voteFields":{"yes":"yes","no":"no"},
                 "methodField":"method","confidenceField":"confidence","relationshipField":"relationship"})
    library=_fixture_catalog(tmp_path,monkeypatch,entry)
    project=library.build_project("fixture",use_cache=False)
    render=project["renderData"];library_block=render["library"]
    assert library_block["crosswalk"]["accepted"]==2 and library_block["crosswalk"]["unmatched"]==1
    assert library_block["crosswalk"]["acceptedVotes"]=={"yes":11.0,"no":5.0}
    assert library_block["crosswalk"]["relationships"]=={"one-to-one":2,"unresolved":1}
    assert not any(item["code"]=="CROSSWALK_VOTE_MISMATCH" for item in render["diagnostics"])
    unmatched=[record for record in render["records"] if record.get("unmatchedSource")]
    assert [record["candidateVotes"] for record in unmatched]==[{"yes":4,"no":1}]

    audit.write_text(audit.read_text().replace("Box A,vtd1,exact-code,high,one-to-one,True,6,3","Box A,vtd1,exact-code,high,one-to-one,True,60,3"))
    rebuilt=library.build_project("fixture",use_cache=False)
    mismatch=next(item for item in rebuilt["renderData"]["diagnostics"] if item["code"]=="CROSSWALK_VOTE_MISMATCH")
    assert mismatch["records"][0]["candidate"]=="yes"
    assert rebuilt["renderData"]["library"]["crosswalk"]["geometryMismatch"]["yes"]==54.0


def test_cached_project_reuses_and_invalidates_on_input_revision(tmp_path, monkeypatch):
    """The served cache is stable across identical requests and rebuilt when any declared input changes."""
    import json
    import pytest
    from pathlib import Path
    import geopandas as gpd
    from shapely.geometry import box

    source=tmp_path / "geometry.gpkg"
    gpd.GeoDataFrame({"precinct_id":["one"],"a":[5]},geometry=[box(-86,32,-85,33)],crs=4326).to_file(source,layer="results",driver="GPKG")
    results=tmp_path / "results.csv"
    results.write_text("precinct_id,a\none,5\n")
    entry=_fixture_entry(source,[{"id":"a","column":"a","displayName":"A","color":"#0000ff"}],results={"path":results.name})
    library=_fixture_catalog(tmp_path,monkeypatch,entry)

    first=library.cached_project("fixture")
    assert library.cached_project("fixture")==first
    assert library.build_project("fixture")["renderData"]["records"][0]["candidateVotes"]=={"a":5}

    results.write_text("precinct_id,a\none,6\n")
    original_write=Path.write_text
    def interrupted_write(path, text, *args, **kwargs):
        original_write(path,text[:40],*args,**kwargs)
        raise OSError("disk full")
    with monkeypatch.context() as patch:
        patch.setattr(Path,"write_text",interrupted_write)
        with pytest.raises(OSError,match="disk full"):
            library.cached_project("fixture")
    second=library.cached_project("fixture")
    assert json.loads(first.read_text())["renderData"]["records"][0]["candidateVotes"]=={"a":5}
    assert library.build_project("fixture")["renderData"]["records"][0]["candidateVotes"]=={"a":6}
    assert library.cached_project("fixture")==second


def test_shapefile_sidecars_participate_in_cache_invalidation(tmp_path, monkeypatch):
    """A shapefile is one dataset across sidecars, so an attribute-only edit must not reuse the cache."""
    import shutil
    import geopandas as gpd
    from shapely.geometry import box

    shapefile=tmp_path / "precincts.shp"
    gpd.GeoDataFrame({"pid":["one"],"a":[5]},geometry=[box(-86,32,-85,33)],crs=4326).to_file(shapefile,driver="ESRI Shapefile")
    entry=_fixture_entry(shapefile,[{"id":"a","column":"a","displayName":"A","color":"#0000ff"}],layer=None)
    entry["keyField"]="pid"
    library=_fixture_catalog(tmp_path,monkeypatch,entry)

    first=library.cached_project("fixture")
    assert library.build_project("fixture")["renderData"]["records"][0]["candidateVotes"]=={"a":5}

    replacement=tmp_path / "replacement.shp"
    gpd.GeoDataFrame({"pid":["one"],"a":[9]},geometry=[box(-86,32,-85,33)],crs=4326).to_file(replacement,driver="ESRI Shapefile")
    shutil.copyfile(replacement.with_suffix(".dbf"),shapefile.with_suffix(".dbf"))
    rebuilt=library.cached_project("fixture")
    assert rebuilt!=first
    assert library.build_project("fixture")["renderData"]["records"][0]["candidateVotes"]=={"a":9}


def test_preview_thumbnail_is_small_cached_and_source_preserving(tmp_path, monkeypatch):
    """Library cards must not decode the multi-thousand-pixel publication rasters."""
    import hashlib
    from PIL import Image
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from political_map_studio import library

    root=tmp_path / "workspace"
    root.mkdir()
    preview=root / "published-preview.png"
    original_image=Image.effect_noise((1200,900),48).convert("RGBA")
    original_image.putalpha(128)
    original_image.save(preview)
    original_image.close()
    import json
    entry={"id":"thumb","preview":preview.name}
    catalog_path=tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps({"schemaVersion":1,"entries":[entry]}))
    monkeypatch.setattr(library,"ELECTION_MAPS_ROOT",root)
    monkeypatch.setattr(library,"CATALOG_PATH",catalog_path)
    monkeypatch.setattr(library,"PREVIEW_CACHE_ROOT",tmp_path / "previews")
    original=hashlib.sha256(preview.read_bytes()).hexdigest()

    barrier=Barrier(2)
    original_save=Image.Image.save
    def simultaneous_save(image, *args, **kwargs):
        original_save(image,*args,**kwargs)
        barrier.wait(timeout=10)
    with monkeypatch.context() as patch:
        patch.setattr(Image.Image,"save",simultaneous_save)
        with ThreadPoolExecutor(max_workers=2) as pool:
            requests=[pool.submit(library.preview_thumbnail,"thumb",160) for _ in range(2)]
            published=[request.result(timeout=15) for request in requests]
    path,media_type=published[0]
    assert published[1] == published[0]
    assert path.stat().st_size < preview.stat().st_size
    assert media_type in {"image/webp","image/png"}
    with Image.open(path) as image:
        assert max(image.size)==160
        assert image.getchannel("A").getextrema() == (128,128)
    assert library.preview_thumbnail("thumb",160)[0]==path

    os_touch = preview.stat().st_mtime_ns + 1_000_000
    import os
    os.utime(preview,ns=(os_touch,os_touch))
    rebuilt,_=library.preview_thumbnail("thumb",160)
    assert rebuilt!=path
    assert hashlib.sha256(preview.read_bytes()).hexdigest()==original


def test_bundled_synthetic_library_is_available_and_preserves_totals():
    entries = catalog()["entries"]
    assert len(entries) == 1
    assert entries[0]["id"] == "synthetic-demo"
    assert entries[0]["available"]
    project = build_project("synthetic-demo", use_cache=False)
    assert len(project["renderData"]["features"]) == 6
    totals = {
        candidate["id"]: sum(record["candidateVotes"][candidate["id"]] for record in project["renderData"]["records"])
        for candidate in project["data"]["candidates"]
    }
    assert totals == {"jones": 2690, "boyd": 1095, "flowers": 925, "brown": 1190}
    assert project["dataset"]["matchStatus"] == "synthetic-fixture"
