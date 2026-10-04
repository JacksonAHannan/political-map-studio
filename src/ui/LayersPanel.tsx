import { useState } from "react";
import { createElement } from "../model/design";
import type { Project, StudioElement } from "../model/types";

const ADDABLE: Array<{ type: StudioElement["type"]; label: string }> = [
  { type: "text", label: "Text" }, { type: "legend", label: "Legend" }, { type: "shape", label: "Shape" },
  { type: "inset", label: "Inset" }, { type: "results", label: "Results" }, { type: "map", label: "Map" },
  { type: "selector", label: "Dataset key" }, { type: "header", label: "Header" },
];

export function LayersPanel({ project, selected, onSelect, onChange, onDuplicate }: { project: Project; selected?: string; onSelect: (id: string) => void; onChange: (fn: (project: Project) => void) => void; onDuplicate: () => void }) {
  const [addType, setAddType] = useState<StudioElement["type"]>("text");
  const layers = [...project.elements].sort((a, b) => b.zIndex - a.zIndex);
  const add = () => {
    const element = createElement(addType, project);
    onChange(draft => { draft.elements.push(element); });
    onSelect(element.id);
  };
  return <aside className="layers">
    <div className="panel-heading"><div><span>Document</span><strong>Layers</strong></div><button title="Add text layer" onClick={() => { setAddType("text"); onChange(draft => draft.elements.push(createElement("text", draft))); }}>＋</button></div>
    <div className="layer-add">
      <select value={addType} onChange={event => setAddType(event.target.value as StudioElement["type"])}>{ADDABLE.map(entry => <option key={entry.type} value={entry.type}>{entry.label}</option>)}</select>
      <button onClick={add}>Add layer</button>
    </div>
    <div className="layer-list">{layers.map(layer => <div key={layer.id} draggable onDragStart={event => event.dataTransfer.setData("text/layer", layer.id)} onDragOver={event => event.preventDefault()} onDrop={event => { const moved = event.dataTransfer.getData("text/layer"); onChange(draft => { const a = draft.elements.find(item => item.id === moved), b = draft.elements.find(item => item.id === layer.id); if (a && b) [a.zIndex, b.zIndex] = [b.zIndex, a.zIndex]; }); }} className={`layer ${selected === layer.id ? "selected" : ""}`} onClick={() => onSelect(layer.id)}>
      <span className="grip">⠿</span><span className={`type-icon type-${layer.type}`}>{icons[layer.type] || "◇"}</span><span className="layer-name">{layer.name}</span>
      {layer.dataset === "comparison" && <span className="layer-dataset" title="Draws from the comparison election">B</span>}
      <button title="Visibility" onClick={event => { event.stopPropagation(); onChange(draft => { const target = draft.elements.find(item => item.id === layer.id); if (target) target.visible = !layer.visible; }); }}>{layer.visible ? "◉" : "○"}</button>
      <button title="Lock" onClick={event => { event.stopPropagation(); onChange(draft => { const target = draft.elements.find(item => item.id === layer.id); if (target) target.locked = !layer.locked; }); }}>{layer.locked ? "▣" : "□"}</button>
    </div>)}</div>
    <div className="layer-actions">
      <button onClick={onDuplicate}>Duplicate</button>
      <button onClick={() => onChange(draft => { draft.elements.forEach(element => { element.locked = false; }); })}>Unlock all</button>
      <button onClick={() => onChange(draft => { draft.elements = draft.elements.filter(element => element.visible); })}>Remove hidden</button>
    </div>
    {!project.comparison && <p className="hint">No comparison election loaded: comparison-dataset layers render a placeholder until one is attached.</p>}
  </aside>;
}

const icons: Record<string, string> = { header: "H", map: "⌑", results: "▤", inset: "▧", text: "T", legend: "L", shape: "◇", selector: "◫" };
