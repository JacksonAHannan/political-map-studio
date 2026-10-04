from __future__ import annotations
import json, subprocess
from pathlib import Path
import typer, cairosvg
app=typer.Typer(help="Render Political Map Studio projects with the same SVG engine as the GUI.")
ROOT=Path(__file__).resolve().parents[2]
@app.command()
def render(project:Path,output:Path=typer.Option(...,"--output","-o")):
    """Render a .pmap.json project to SVG, PNG, or PDF."""
    if output.suffix.lower() not in {".svg",".png",".pdf"}:raise typer.BadParameter("Output must be SVG, PNG, or PDF")
    svg_path=output if output.suffix.lower()==".svg" else output.with_suffix(".render.svg")
    renderer=ROOT/"scripts/render-project.cjs"
    if not renderer.exists():raise typer.BadParameter("CLI renderer is not built; run npm run build")
    subprocess.run(["node",str(renderer),str(project),str(svg_path)],check=True,cwd=ROOT)
    if output.suffix.lower()==".png":cairosvg.svg2png(url=str(svg_path),write_to=str(output),dpi=json.loads(project.read_text())["page"]["dpi"])
    elif output.suffix.lower()==".pdf":cairosvg.svg2pdf(url=str(svg_path),write_to=str(output))
    if svg_path!=output:svg_path.unlink()
    typer.echo(str(output))
@app.command("render-template")
def render_template(template:Path,results:Path=typer.Option(...,"--results"),geography:Path=typer.Option(...,"--geography"),metadata:Path=typer.Option(...,"--metadata"),output:Path=typer.Option(...,"--output","-o")):
    """Materialize a template with local data, then render it."""
    from .processing import process
    base=json.loads((ROOT/"public/examples/alabama_demo.pmap.json").read_text());spec=json.loads(template.read_text());meta=json.loads(metadata.read_text())
    base["page"]=spec.get("page",base["page"]);base["elements"]=spec.get("elements",base["elements"]);base["metadata"]={**base["metadata"],**meta.get("metadata",meta)};base["data"]={**base["data"],**meta.get("data",{})};base["theme"]={**base["theme"],**meta.get("theme",{})};spec=base
    project=process(spec,geography,results,spec["data"]["join"]["geographyField"],spec["data"]["join"]["resultField"],spec["data"].get("resultsFormat","wide"))
    temporary=output.with_suffix(".materialized.pmap.json");temporary.write_text(json.dumps(project));render(temporary,output);temporary.unlink()
@app.command("library-list")
def library_list():
    """List pre-matched local election projects."""
    from .library import catalog
    for entry in catalog()["entries"]:typer.echo(f"{entry['id']}\t{entry['state']}\t{entry['year']}\t{entry['race']}\t{'ready' if entry['available'] else 'missing'}")
@app.command("library-warm")
def library_warm():
    """Prebuild every available library project for instant switching."""
    from .library import warm_cache
    for item in warm_cache():typer.echo(f"{item['id']}\t{item['status']}\t{item.get('features','')}")
if __name__=="__main__":app()
