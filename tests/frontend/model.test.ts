import { describe,expect,it } from "vitest";
import fs from "node:fs";
import { candidateTotals,deriveRecord,interpolate } from "../../src/model/derive";
import { commit,redo,undo } from "../../src/model/history";
import { renderFeatureSchema, validateProject } from "../../src/model/schema";
import { visualDiagnostics } from "../../src/model/diagnostics";
import { type Candidate, type Project } from "../../src/model/types";
const candidates:Candidate[]=[{id:"a",sourceNames:[],displayName:"A",color:"#145DA0",visible:true,order:0},{id:"b",sourceNames:[],displayName:"B",color:"#D64F8A",visible:true,order:1}];
describe("election derivation",()=>{
 it("calculates winner, runner-up, margin and totals",()=>{const row=deriveRecord("p1",{a:60,b:40},candidates);expect(row.winnerId).toBe("a");expect(row.runnerUpId).toBe("b");expect(row.margin).toBeCloseTo(.2);expect(candidateTotals([row],candidates)).toEqual({a:60,b:40})});
 it("interpolates deterministic colors",()=>expect(interpolate("#000000",1)).toBe("#000000"));
});
describe("project document",()=>{
 const raw=JSON.parse(fs.readFileSync("public/examples/alabama_demo.pmap.json","utf8"));
 it("validates and round trips",()=>{expect(validateProject(JSON.parse(JSON.stringify(raw))).success).toBe(true)});
 it("rejects unsupported modes and malformed render data",()=>{const p=structuredClone(raw);p.elements=[{id:"map",name:"Map",type:"map",frame:{x:0,y:0,width:10,height:10},visible:true,locked:false,zIndex:1,opacity:1,projection:{type:"identity"},style:{mode:"turnout",minStrength:0,maxStrength:1,domain:[0,1],reverse:false,noDataColor:"#ffffff"}}];expect(validateProject(p).success).toBe(false);p.elements=[];p.renderData.features=[{type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:"bad"}}];expect(validateProject(p).success).toBe(false)});
 it("rejects malformed candidates, records, diagnostics, and element discriminators",()=>{for(const mutate of [(p:any)=>p.data.candidates[0].color="blue",(p:any)=>p.renderData.records=[{key:"x"}],(p:any)=>p.renderData.diagnostics=[{severity:"urgent",code:"X",message:"bad"}],(p:any)=>p.elements=[{type:"unknown"}]]){const p=structuredClone(raw);mutate(p);expect(validateProject(p).success).toBe(false)}});
 it("supports undo and redo",()=>{const p=raw as Project,s={past:[],present:p,future:[]};const next={...p,name:"Changed"};const committed=commit(s,next);expect(undo(committed).present.name).toBe(p.name);expect(redo(undo(committed)).present.name).toBe("Changed")});
 it("detects canvas and inset scale problems",()=>{const p=structuredClone(raw) as Project;p.elements=[];p.data.candidates[0].color="bad";expect(visualDiagnostics(p).map(x=>x.code)).toContain("INVALID_CANDIDATE_COLOR")});
});

describe("geometry validation", () => {
 it("validates collections and rejects malformed coordinates after an earlier successful check", () => {
  const feature = { type: "Feature", properties: {}, geometry: { type: "GeometryCollection", geometries: [
   { type: "Point", coordinates: [1, 2, 3] },
   { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [0, 1], [0, 0]]]] },
   { type: "Point", coordinates: [] },
  ] } };
  expect(renderFeatureSchema.safeParse(feature).success).toBe(true);
  feature.geometry.geometries[0].coordinates = [1, NaN];
  expect(renderFeatureSchema.safeParse(feature).success).toBe(false);
 });
 it("rejects incorrect coordinate depth without accepting arbitrary nested arrays", () => {
  for (const geometry of [
   { type: "Point", coordinates: [[1, 2]] },
   { type: "Polygon", coordinates: [[0, 0], [1, 0], [0, 1], [0, 0]] },
   { type: "LineString", coordinates: [[1], [2]] },
   { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, Infinity] }] },
  ]) expect(renderFeatureSchema.safeParse({ type: "Feature", properties: {}, geometry }).success).toBe(false);
 });
});
