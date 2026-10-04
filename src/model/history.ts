import type { Project } from "./types";

export type HistoryState={past:Project[];present:Project;future:Project[]};
export function commit(state:HistoryState,next:Project):HistoryState { return {past:[...state.past,state.present].slice(-100),present:next,future:[]}; }
export function undo(state:HistoryState):HistoryState { if(!state.past.length)return state; const previous=state.past.at(-1)!; return {past:state.past.slice(0,-1),present:previous,future:[state.present,...state.future]}; }
export function redo(state:HistoryState):HistoryState { if(!state.future.length)return state; const next=state.future[0]; return {past:[...state.past,state.present],present:next,future:state.future.slice(1)}; }
