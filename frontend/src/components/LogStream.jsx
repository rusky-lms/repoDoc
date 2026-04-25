import React, { useEffect, useRef } from "react";

const LEVEL_COLORS = {
  info: "text-zinc-300",
  warning: "text-yellow-400",
  error: "text-red-400",
  success: "text-emerald-400",
};

export default function LogStream({ logs = [], isRunning = false }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="log-container border border-zinc-800 bg-[#0D0D0D]" data-testid="log-stream">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
        <span className="text-xs font-mono text-zinc-500">
          {isRunning ? "live log" : "log"}
        </span>
        <span className="ml-auto text-xs font-mono text-zinc-600">{logs.length} entries</span>
      </div>
      <div className="p-2 space-y-0.5">
        {logs.length === 0 ? (
          <p className="text-xs font-mono text-zinc-600 p-2">Waiting for logs...</p>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="flex gap-2 items-start">
              <span className="text-xs font-mono text-zinc-600 shrink-0 w-6 text-right">
                {i + 1}
              </span>
              <span
                className={`text-xs font-mono ${LEVEL_COLORS[log.level] || "text-zinc-300"} leading-relaxed`}
              >
                {log.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
