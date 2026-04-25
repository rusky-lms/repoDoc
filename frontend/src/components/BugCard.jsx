import React from "react";
import { AlertTriangle, TestTube, FileCode } from "lucide-react";

const TYPE_CONFIG = {
  failing_test: { label: "Test Failure", color: "text-red-400 bg-red-900/20 border-red-800", icon: TestTube },
  lint: { label: "Lint Error", color: "text-yellow-400 bg-yellow-900/20 border-yellow-800", icon: AlertTriangle },
  logical: { label: "Logical Bug", color: "text-orange-400 bg-orange-900/20 border-orange-800", icon: AlertTriangle },
};

const SEVERITY_BADGE = {
  high: "bg-red-900/40 text-red-400 border border-red-800",
  medium: "bg-yellow-900/40 text-yellow-400 border border-yellow-800",
  low: "bg-zinc-800 text-zinc-400 border border-zinc-700",
};

export default function BugCard({ bug, fix }) {
  const config = TYPE_CONFIG[bug.type] || TYPE_CONFIG.logical;
  const Icon = config.icon;
  const isFixed = fix?.verified;

  return (
    <div
      className="border border-zinc-800 bg-[#111111] p-4"
      data-testid={`bug-card-${bug.id}`}
    >
      <div className="flex items-start gap-3">
        <div className={`p-1.5 border ${config.color} shrink-0`}>
          <Icon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-xs px-2 py-0.5 border ${config.color} font-mono`}>
              {config.label}
            </span>
            <span className={`text-xs px-2 py-0.5 font-mono ${SEVERITY_BADGE[bug.severity] || SEVERITY_BADGE.medium}`}>
              {bug.severity}
            </span>
            {isFixed && (
              <span className="text-xs px-2 py-0.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800 font-mono">
                fixed & verified
              </span>
            )}
          </div>

          <p className="text-sm text-white mb-1 leading-snug">{bug.description}</p>

          {bug.file && (
            <div className="flex items-center gap-1 text-xs font-mono text-zinc-500">
              <FileCode size={11} />
              <span>{bug.file}</span>
              {bug.line && <span>:{bug.line}</span>}
            </div>
          )}

          {bug.stacktrace && (
            <pre className="mt-2 text-xs font-mono text-zinc-500 bg-[#0A0A0A] p-2 overflow-x-auto max-h-32 border border-zinc-800">
              {bug.stacktrace.slice(0, 600)}
            </pre>
          )}

          {fix && (
            <div className="mt-2 text-xs text-zinc-400 border-l-2 border-emerald-700 pl-2">
              <span className="text-emerald-400 font-mono">fix: </span>
              {fix.explanation}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
