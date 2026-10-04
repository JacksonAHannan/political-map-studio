import json
from pathlib import Path
import geopandas as gpd
import pandas as pd
import pytest
import zipfile
from shapely.geometry import box
from political_map_studio.processing import process, safe_vector_path

def base_project():
    return json.loads(Path("public/examples/alabama_demo.pmap.json").read_text())

def test_join_totals_margin_and_diagnostics(tmp_path):
    geo=gpd.GeoDataFrame({"precinct_id":["A","B"],"name":["Alpha","Beta"]},geometry=[box(0,0,1,1),box(1,0,2,1)],crs="EPSG:4326")
    geo_path=tmp_path/"g.geojson";geo.to_file(geo_path,driver="GeoJSON")
    results=pd.DataFrame({"precinct_id":["A","C"],"jones":[60,5],"boyd":[40,3],"flowers":[0,1],"brown":[0,0]});results_path=tmp_path/"r.csv";results.to_csv(results_path,index=False)
    project=base_project();project["data"]["fields"]["precinctName"]="name"
    output=process(project,geo_path,results_path,"precinct_id","precinct_id","wide")
    records={x["key"]:x for x in output["renderData"]["records"]}
    assert records["a"]["totalVotes"]==100
    assert records["a"]["winnerId"]=="jones"
    assert records["a"]["margin"]==.2
    codes={x["code"] for x in output["renderData"]["diagnostics"]}
    assert {"UNMATCHED_RESULTS","UNMATCHED_POLYGONS","NO_CANDIDATE_VOTES"}<=codes
    assert output["renderData"]["crs"]

def test_duplicate_keys_are_not_silent(tmp_path):
    geo=gpd.GeoDataFrame({"id":["A","A"]},geometry=[box(0,0,1,1),box(1,0,2,1)],crs="EPSG:3857")
    gp=tmp_path/"g.geojson";geo.to_file(gp,driver="GeoJSON")
    rp=tmp_path/"r.csv";pd.DataFrame({"id":["A"],"jones":[1],"boyd":[0],"flowers":[0],"brown":[0]}).to_csv(rp,index=False)
    out=process(base_project(),gp,rp,"id","id","wide")
    assert any(d["code"]=="DUPLICATE_GEOGRAPHY_KEYS" for d in out["renderData"]["diagnostics"])

def test_zipped_shapefile_is_the_supported_shapefile_transport(tmp_path):
    shape_dir=tmp_path/"shape";shape_dir.mkdir()
    geo=gpd.GeoDataFrame({"id":["A"]},geometry=[box(0,0,1,1)],crs="EPSG:3857")
    geo.to_file(shape_dir/"precincts.shp")
    archive_path=tmp_path/"precincts.zip"
    with zipfile.ZipFile(archive_path,"w") as archive:
        for part in shape_dir.iterdir(): archive.write(part,part.name)
    extracted=safe_vector_path(archive_path,tmp_path/"extract")
    assert extracted.name=="precincts.shp"
    assert len(gpd.read_file(extracted))==1

def test_bare_shapefile_and_topojson_are_rejected_precisely(tmp_path):
    with pytest.raises(ValueError,match="Unsupported geography type: .shp"):
        safe_vector_path(tmp_path/"precincts.shp",tmp_path/"extract")
    with pytest.raises(ValueError,match="TopoJSON import is not supported; convert it to GeoJSON"):
        safe_vector_path(tmp_path/"precincts.topojson",tmp_path/"extract")
