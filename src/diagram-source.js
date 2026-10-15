// Recognize a standalone definition, never ordinary prose mentioning Mermaid.
export function isDiagramSource(source) {
  return /^(?:(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|journey|mindmap|timeline|gitGraph|pie|quadrantChart|requirementDiagram|block-beta|packet-beta|architecture-beta|xychart-beta|sankey-beta)\b)/.test(source.trim());
}
