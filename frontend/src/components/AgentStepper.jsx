import React from "react";
import { CheckCircle, Circle, Loader, XCircle, SkipForward } from "lucide-react";

const STEP_LABELS = {
  observe: "Observe",
  decide: "Decide",
  act: "Act",
  verify: "Verify",
  create_pr: "Create PR",
};

const STEP_DESCRIPTIONS = {
  observe: "Clone repo & map files",
  decide: "Plan analysis strategy",
  act: "Run tests & lint",
  verify: "Generate & verify fixes",
  create_pr: "Open GitHub PR",
};

function StepIcon({ status }) {
  if (status === "completed") return <CheckCircle size={18} className="text-emerald-400" />;
  if (status === "failed") return <XCircle size={18} className="text-red-400" />;
  if (status === "active") return <Loader size={18} className="text-emerald-400 animate-spin" />;
  if (status === "skipped") return <SkipForward size={18} className="text-zinc-600" />;
  return <Circle size={18} className="text-zinc-600" />;
}

export default function AgentStepper({ steps = [] }) {
  const defaultSteps = [
    { step: "observe", label: "Observe", status: "pending" },
    { step: "decide", label: "Decide", status: "pending" },
    { step: "act", label: "Act", status: "pending" },
    { step: "verify", label: "Verify", status: "pending" },
    { step: "create_pr", label: "Create PR", status: "pending" },
  ];

  const displaySteps = steps.length > 0 ? steps : defaultSteps;

  return (
    <div className="flex flex-col gap-0" data-testid="agent-stepper">
      {displaySteps.map((step, i) => {
        const isActive = step.status === "active";
        const isDone = step.status === "completed";
        const isFailed = step.status === "failed";
        const isLast = i === displaySteps.length - 1;

        return (
          <div key={step.step} className="flex gap-3">
            {/* Line connector */}
            <div className="flex flex-col items-center">
              <div className={`${isActive ? "step-active" : ""}`}>
                <StepIcon status={step.status} />
              </div>
              {!isLast && (
                <div
                  className={`w-px flex-1 mt-1 mb-1 ${
                    isDone ? "bg-emerald-400/40" : "bg-zinc-800"
                  }`}
                  style={{ minHeight: "24px" }}
                />
              )}
            </div>

            {/* Step content */}
            <div className={`pb-4 flex-1 ${isLast ? "" : ""}`}>
              <div className="flex items-center gap-2">
                <span
                  className={`text-sm font-[Chivo] font-bold ${
                    isActive
                      ? "text-emerald-400"
                      : isDone
                      ? "text-white"
                      : isFailed
                      ? "text-red-400"
                      : "text-zinc-500"
                  }`}
                >
                  {STEP_LABELS[step.step] || step.label || step.step}
                </span>
                {isActive && (
                  <span className="text-xs text-emerald-400 animate-pulse-emerald">running</span>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                {step.message || STEP_DESCRIPTIONS[step.step] || ""}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
