import type { Candidate, DerivedRecord } from "./types";

export function deriveRecord(key:string, votes:Record<string,number>, candidates:Candidate[], extra:Record<string,string|number|null>={}):DerivedRecord {
  const visible=candidates.filter(c=>c.visible).map(c=>({id:c.id,votes:Number(votes[c.id]||0)})).sort((a,b)=>b.votes-a.votes||a.id.localeCompare(b.id));
  const totalVotes=visible.reduce((sum,c)=>sum+c.votes,0), winner=visible[0], runner=visible[1];
  return { key,totalVotes,winnerId:totalVotes?winner?.id:undefined,runnerUpId:totalVotes?runner?.id:undefined,
    margin:totalVotes&&winner?(winner.votes-(runner?.votes||0))/totalVotes:undefined,values:extra,candidateVotes:votes };
}

export function candidateTotals(records:DerivedRecord[], candidates:Candidate[]) {
  const totals=Object.fromEntries(candidates.map(c=>[c.id,0]));
  for(const row of records) for(const candidate of candidates) totals[candidate.id]+=(row.candidateVotes[candidate.id]||0);
  return totals;
}

const LIGHT_FALLBACK: [number, number, number] = [232, 237, 240];

/** Parses `#rrggbb`; library sources may carry JSON nulls or unvalidated colors, so never throw. */
function rgb(value: string | null | undefined, fallback: [number, number, number]): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec((value ?? "").trim());
  return match ? match[1].match(/.{2}/g)!.map(part => parseInt(part, 16)) as [number, number, number] : fallback;
}

export function interpolate(hex:string,strength:number,light?:string|null) {
  const [a,b]=[rgb(light,LIGHT_FALLBACK),rgb(hex,LIGHT_FALLBACK)];
  return `#${a.map((v,i)=>Math.round(v+(b[i]-v)*Math.max(0,Math.min(1,strength))).toString(16).padStart(2,"0")).join("")}`;
}
