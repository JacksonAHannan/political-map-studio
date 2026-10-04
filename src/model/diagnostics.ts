import type { Diagnostic, Project } from "./types";
export function visualDiagnostics(project:Project):Diagnostic[]{
 const out:Diagnostic[]=[];
 for(const element of project.elements){const f=element.frame;if(f.x<0||f.y<0||f.x+f.width>project.page.width||f.y+f.height>project.page.height)out.push({severity:"warning",code:"ELEMENT_OUTSIDE_CANVAS",message:`${element.name} extends beyond the export canvas`,fix:"Move or resize the element."});}
 const groups=new Map<string,Array<{name:string;width:number;height:number}>>();
 for(const element of project.elements)if(element.type==="inset"&&element.scaleMode==="identical"&&element.scaleGroup){const list=groups.get(element.scaleGroup)||[];list.push({name:element.name,width:element.frame.width,height:element.frame.height});groups.set(element.scaleGroup,list)}
 for(const [group,items] of groups){if(new Set(items.map(x=>`${x.width}:${x.height}`)).size>1)out.push({severity:"warning",code:"INSET_SCALE_SIZE_MISMATCH",message:`Inset group ${group} has different frame sizes`,fix:"Use identical dimensions to preserve identical scale."})}
 for(const c of project.data.candidates)if(!/^#[0-9a-f]{6}$/i.test(c.color))out.push({severity:"error",code:"INVALID_CANDIDATE_COLOR",message:`${c.displayName} has an invalid color: ${c.color}`});
 return out;
}
