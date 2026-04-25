import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

function DiffLine({ line }) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return (
      <div className="bg-emerald-900/20 text-emerald-400 px-3 py-0.5 whitespace-pre">
        {line}
      </div>
    );
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return (
      <div className="bg-red-900/20 text-red-400 px-3 py-0.5 whitespace-pre">
        {line}
      </div>
    );
  }
  if (line.startsWith("---") || line.startsWith("+++")) {
    return (
      <div className="text-zinc-500 px-3 py-0.5 whitespace-pre text-xs">
        {line}
      </div>
    );
  }
  return (
    <div className="text-zinc-300 px-3 py-0.5 whitespace-pre">
      {line}
    </div>
  );
}

export default function CodeDiff({ originalCode, fixedCode, diff, file }) {
  const [expanded, setExpanded] = useState(true);

  // Prefer diff if available, else build from original/fixed
  let diffLines = [];
  if (diff) {
    diffLines = diff.split("\n");
  } else if (originalCode || fixedCode) {
    const orig = (originalCode || "").split("\n");
    const fixed = (fixedCode || "").split("\n");
    diffLines = [
      `--- ${file || "original"}`,
      `+++ ${file || "fixed"}`,
      ...orig.map((l) => `-${l}`),
      ...fixed.map((l) => `+${l}`),
    ];
  }

  if (!diffLines.length) return null;

  return (
    <div className="border border-zinc-800 bg-[#0D0D0D]" data-testid="code-diff">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-zinc-400 hover:bg-zinc-900 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-zinc-500">{file || "diff"}</span>
        <span className="ml-auto text-zinc-600">
          {diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length} additions,{" "}
          {diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length} deletions
        </span>
      </button>
      {expanded && (
        <div className="font-mono text-sm overflow-x-auto">
          {diffLines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}
