import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapRenderer } from "../src/render/MapRenderer";
import { validateProject } from "../src/model/schema";
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error("Usage: render-project.tsx project.pmap.json output.svg");
let value=JSON.parse(fs.readFileSync(input,"utf8"));
if(!value.elements?.length&&value.layoutId){const templatePath=path.join(process.cwd(),"public/templates/alabama_editorial.json");const template=JSON.parse(fs.readFileSync(templatePath,"utf8"));const bind=(s:string)=>s.replaceAll("{{metadata.title}}",value.metadata.title).replaceAll("{{metadata.subtitle}}",value.metadata.subtitle).replaceAll("{{metadata.source}}",value.metadata.source).replaceAll("{{metadata.electionType}}",value.metadata.electionType).replaceAll("{{year}}",value.metadata.electionDate.slice(0,4));value={...value,elements:template.elements.map((e:any)=>{if(e.type==="header"){e.title=bind(e.title);e.subtitle=bind(e.subtitle);e.kicker=bind(e.kicker);e.identifier=bind(e.identifier)}if(e.type==="text")e.text=bind(e.text);return e})}}
const check=validateProject(value);if(!check.success)throw new Error(check.error.message);
const markup=renderToStaticMarkup(<MapRenderer project={value}/>);fs.writeFileSync(output,`<?xml version="1.0" encoding="UTF-8"?>\n${markup}\n`);
