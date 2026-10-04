import { describe,expect,it } from "vitest";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapRenderer } from "../../src/render/MapRenderer";
import { applyLayout, applyDesign, createDesign, withComparison } from "../../src/model/design";
import type { MainMapElement, Project } from "../../src/model/types";

function fixture():Project{
  const project=JSON.parse(fs.readFileSync("public/examples/alabama_demo.pmap.json","utf8")) as Project;
  project.elements=[{id:"map",name:"Map",type:"map",frame:{x:0,y:0,width:300,height:200},visible:true,locked:false,zIndex:1,opacity:1,projection:{type:"identity"},zoom:1,pan:[0,0],style:{mode:"winner-margin",continuous:true,buckets:5,thresholds:[],minStrength:.2,maxStrength:1,domain:[0,1],reverse:false,noDataColor:"#eeeeee",unopposedColor:"#999999",precinctStroke:"#ffffff",precinctStrokeWidth:1,precinctStrokeOpacity:1,countyStroke:"#000000",countyStrokeWidth:1,countyStrokeOpacity:1,exteriorStroke:"#000000",exteriorStrokeWidth:1,background:"#ffffff",antialias:true,clip:true}}];
  project.renderData.features=[{type:"Feature",properties:{__joinKey:"a"},geometry:{type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}}];
  project.renderData.bounds=[0,0,1,1];
  project.renderData.records=[{key:"a",totalVotes:100,winnerId:project.data.candidates[0].id,runnerUpId:project.data.candidates[1].id,margin:.2,values:{},candidateVotes:{[project.data.candidates[0].id]:60,[project.data.candidates[1].id]:40}}];
  return project;
}
const render=(project:Project)=>renderToStaticMarkup(<MapRenderer project={project}/>);
describe("map renderer modes",()=>{
  it("renders winner and winner-margin differently",()=>{const project=fixture(),margin=render(project);(project.elements[0] as MainMapElement).style.mode="winner";expect(render(project)).not.toBe(margin)});
  it("honors reverse for winner-margin",()=>{const project=fixture(),normal=render(project);(project.elements[0] as MainMapElement).style.reverse=true;expect(render(project)).not.toBe(normal)});
});

describe("layout rendering integrity", () => {
  it("retains a spherical arc entering the frame away from its endpoints", () => {
    const project = fixture();
    const map = project.elements[0] as MainMapElement;
    map.projection.type = "mercator";
    map.extent = [-5, 18, 5, 21];
    project.renderData.features[0].geometry = { type: "LineString", coordinates: [[-60, 10], [60, 10]] };
    project.renderData.bounds = [-60, 10, 60, 10];
    const svg = new DOMParser().parseFromString(render(project), "image/svg+xml");
    const path = svg.querySelector("path")?.getAttribute("d");
    expect(path).toBeTruthy();
    const positions = [...path!.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    expect(positions.some(([x, y]) => x > 0 && x < map.frame.width && y > 0 && y < map.frame.height)).toBe(true);
  });

  it("renders equivalent polygon winding identically without changing source geometry", () => {
    const project = fixture();
    (project.elements[0] as MainMapElement).projection.type = "albers";
    project.renderData.bounds = [-80, 40, -79, 41];
    project.renderData.features[0].geometry = { type: "MultiPolygon", coordinates: [[
      [[-80,40],[-79,40],[-79,41],[-80,41],[-80,40]],
      [[-79.8,40.2],[-79.8,40.8],[-79.2,40.8],[-79.2,40.2],[-79.8,40.2]],
    ]] };
    const reverse = structuredClone(project);
    const geometry = reverse.renderData.features[0].geometry;
    if (geometry?.type === "MultiPolygon") geometry.coordinates[0] = geometry.coordinates[0].map(ring => [...ring].reverse());
    const before = JSON.stringify(project.renderData);
    const first = new DOMParser().parseFromString(render(project), "image/svg+xml");
    const second = new DOMParser().parseFromString(render(reverse), "image/svg+xml");
    expect(first.querySelector("path")?.getAttribute("d")).toBe(second.querySelector("path")?.getAttribute("d"));
    expect(JSON.stringify(project.renderData)).toBe(before);
  });

  it("keeps contest totals and shares when a candidate row is hidden", () => {
    const project = applyLayout(fixture(), "results");
    project.data.candidates = project.data.candidates.slice(0, 2).map((candidate, index) => ({ ...candidate, visible: index === 0 }));
    const svg = new DOMParser().parseFromString(render(project), "image/svg+xml");
    const table = svg.querySelector('[data-element-type="results"]')!.textContent!;
    expect(table).toContain("60.00%");
    expect(table).toContain("TOTAL100");
  });

  it("rebinds saved design dates and preserves new election records and color slots", () => {
    const original = applyLayout(fixture(), "results");
    original.data.candidates[0].color = "#6A2CA0";
    const incoming = structuredClone(fixture());
    incoming.metadata.electionDate = "2030-11-05";
    incoming.metadata.electionType = "New election";
    incoming.data.candidates[0].id = "new-candidate";
    incoming.data.candidates[0].displayName = "New candidate";
    const before = JSON.stringify(incoming.renderData);
    const design = JSON.parse(JSON.stringify(createDesign(original, "Reusable")));
    const applied = applyDesign(incoming, design);
    const svg = new DOMParser().parseFromString(render(applied), "image/svg+xml");
    expect(svg.querySelector('[data-element-type="header"]')!.textContent).toContain("2030");
    expect(svg.querySelector('[data-element-type="results"]')!.textContent).toContain("New election");
    expect(applied.data.candidates[0].color).toBe("#6A2CA0");
    expect(applied.data.candidates[0].displayName).toBe("New candidate");
    expect(JSON.stringify(applied.renderData)).toBe(before);
    expect(design).not.toHaveProperty("renderData");
  });

  it("gives each comparison election its own candidate legend", () => {
    const first = fixture(), second = fixture();
    first.data.candidates[0].displayName = "Primary candidate";
    second.data.candidates[0].displayName = "Comparison candidate";
    second.data.candidates[0].color = "#6A2CA0";
    const project = applyLayout(withComparison(first, second).project, "comparison");
    const svg = new DOMParser().parseFromString(render(project), "image/svg+xml");
    const legends = [...svg.querySelectorAll('[data-element-type="legend"]')];
    expect(legends).toHaveLength(2);
    expect(legends.some(legend => legend.textContent?.includes("Primary candidate"))).toBe(true);
    expect(legends.some(legend => legend.textContent?.includes("Comparison candidate") && legend.innerHTML.toLowerCase().includes("#6a2ca0"))).toBe(true);
  });
});
