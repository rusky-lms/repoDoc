import React, { useState, useEffect } from "react";
import axios from "axios";
import {
  ShieldCheck, Plus, Trash2, RefreshCw, Sparkles,
  ShieldAlert, Code2, FileWarning, CheckSquare, Square, X,
  FileText, Upload, Download, Terminal, Check,
} from "lucide-react";
import { API } from "../lib/api";

const SEVERITY_CLASS = {
  critical: "text-red-400 border-red-700",
  warning: "text-amber-400 border-amber-700",
  info: "text-cyan-400 border-cyan-700",
};

const CATEGORY_ICON = {
  security: ShieldAlert,
  quality: Code2,
  compliance: FileWarning,
};

function PresetCard({ preset, onPick, busy }) {
  return (
    <button
      onClick={() => onPick(preset.key)}
      disabled={busy}
      data-testid={`preset-${preset.key}`}
      className="text-left border border-zinc-800 bg-[#111111] p-5 hover:bg-zinc-900 hover:border-emerald-700 transition-all disabled:opacity-50"
    >
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={14} className="text-emerald-400" />
        <span className="text-sm font-[Chivo] font-bold text-white">{preset.name}</span>
      </div>
      <p className="text-xs text-zinc-500 mb-3 leading-relaxed">{preset.description}</p>
      <div className="flex flex-wrap gap-1">
        {preset.rule_ids.map((rid) => (
          <span key={rid} className="text-[10px] font-mono text-zinc-500 border border-zinc-800 px-1.5 py-0.5">
            {rid}
          </span>
        ))}
      </div>
    </button>
  );
}

function RuleRow({ rule, enabled, onToggle, removable, onRemove }) {
  const Icon = CATEGORY_ICON[rule.category] || Code2;
  return (
    <div className="flex items-start gap-3 p-3 border border-zinc-800 bg-[#0F0F0F]" data-testid={`rule-${rule.builtin_id || rule.id}`}>
      <button onClick={onToggle} className="mt-0.5 text-zinc-300 hover:text-emerald-400">
        {enabled ? <CheckSquare size={16} /> : <Square size={16} />}
      </button>
      <Icon size={14} className="mt-1 text-zinc-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-white font-medium">{rule.name}</span>
          <span className={`text-[10px] font-mono px-1.5 py-0.5 border ${SEVERITY_CLASS[rule.severity] || SEVERITY_CLASS.info}`}>
            {rule.severity}
          </span>
          <span className="text-[10px] font-mono text-zinc-500 border border-zinc-800 px-1.5 py-0.5">
            {rule.type}
          </span>
        </div>
        <p className="text-xs text-zinc-500 mt-1">{rule.description}</p>
      </div>
      {removable && (
        <button onClick={onRemove} className="text-zinc-600 hover:text-red-400">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function CustomRuleForm({ onAdd }) {
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [severity, setSeverity] = useState("warning");
  const [category, setCategory] = useState("quality");

  const handleAdd = () => {
    if (!name.trim() || !pattern.trim()) return;
    onAdd({
      id: `custom-${Date.now()}`,
      name: name.trim(),
      description: "Custom regex rule",
      category,
      type: "pattern",
      pattern: pattern.trim(),
      severity,
      enabled: true,
    });
    setName(""); setPattern("");
  };

  return (
    <div className="border border-dashed border-zinc-800 p-4 bg-[#0A0A0A]">
      <p className="text-xs font-mono text-zinc-500 uppercase mb-3 tracking-wider">Add Custom Regex Rule</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Rule name"
          data-testid="custom-rule-name"
          className="bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400"
        />
        <input
          value={pattern} onChange={(e) => setPattern(e.target.value)}
          placeholder="Regex pattern (e.g. ^\\+.*TODO)"
          data-testid="custom-rule-pattern"
          className="bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400"
        />
        <select
          value={category} onChange={(e) => setCategory(e.target.value)}
          className="bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-sm font-mono"
        >
          <option value="security">security</option>
          <option value="quality">quality</option>
          <option value="compliance">compliance</option>
        </select>
        <select
          value={severity} onChange={(e) => setSeverity(e.target.value)}
          className="bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-sm font-mono"
        >
          <option value="critical">critical</option>
          <option value="warning">warning</option>
          <option value="info">info</option>
        </select>
      </div>
      <button
        onClick={handleAdd}
        data-testid="custom-rule-add-btn"
        className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 text-white text-xs hover:bg-zinc-700"
      >
        <Plus size={12} /> Add Rule
      </button>
    </div>
  );
}

function GuardrailsBuilder({ builtin, onSave, onClose }) {
  const [name, setName] = useState("My Custom Ruleset");
  const [enabled, setEnabled] = useState(() => {
    const m = {};
    builtin.rules.forEach((r) => { m[r.id] = false; });
    return m;
  });
  const [customRules, setCustomRules] = useState([]);
  const [saving, setSaving] = useState(false);

  const toggle = (id) => setEnabled((p) => ({ ...p, [id]: !p[id] }));
  const removeCustom = (id) => setCustomRules((p) => p.filter((r) => r.id !== id));

  const handleSave = async () => {
    const rules = [
      ...builtin.rules
        .filter((r) => enabled[r.id])
        .map((r) => ({ ...r, builtin_id: r.id, enabled: true })),
      ...customRules,
    ];
    if (rules.length === 0) return;
    setSaving(true);
    try {
      await axios.post(`${API}/guardrails`, {
        name: name.trim() || "Custom Ruleset",
        description: "User-created ruleset",
        rules,
      });
      onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-zinc-800 bg-[#111111] p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-[Chivo] font-bold text-white uppercase tracking-widest">
          Build Custom Ruleset
        </h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-white" data-testid="builder-close">
          <X size={16} />
        </button>
      </div>
      <input
        value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Ruleset name"
        data-testid="ruleset-name-input"
        className="w-full bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-sm font-mono mb-4 focus:outline-none focus:ring-1 focus:ring-emerald-400"
      />
      <p className="text-xs font-mono text-zinc-500 uppercase mb-2 tracking-wider">Built-in Rules</p>
      <div className="space-y-2 mb-4">
        {builtin.rules.map((r) => (
          <RuleRow
            key={r.id}
            rule={r}
            enabled={!!enabled[r.id]}
            onToggle={() => toggle(r.id)}
          />
        ))}
      </div>
      {customRules.length > 0 && (
        <>
          <p className="text-xs font-mono text-zinc-500 uppercase mb-2 tracking-wider">Custom Rules</p>
          <div className="space-y-2 mb-4">
            {customRules.map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                enabled
                onToggle={() => {}}
                removable
                onRemove={() => removeCustom(r.id)}
              />
            ))}
          </div>
        </>
      )}
      <CustomRuleForm onAdd={(r) => setCustomRules((p) => [...p, r])} />
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white">Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving}
          data-testid="save-ruleset-btn"
          className="px-5 py-2 bg-emerald-400 text-black text-sm font-bold hover:bg-emerald-300 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Ruleset"}
        </button>
      </div>
    </div>
  );
}

function getExportUrl(gid) {
  const path = `${API}/guardrails/${gid}/export.yml`;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${window.location.origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

function ImportFromDocPanel({ saved, onSaved, onClose, onToast }) {
  const [file, setFile] = useState(null);
  const [pastedText, setPastedText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");
  const [extracted, setExtracted] = useState(null); // null = input step, array = review step
  const [selected, setSelected] = useState({});
  const [targetProfileId, setTargetProfileId] = useState("new");
  const [rulesetName, setRulesetName] = useState("ADR Guardrails");
  const [saving, setSaving] = useState(false);

  const handleFileChange = (e) => {
    const picked = e.target.files?.[0] || null;
    setFile(picked);
    setError("");
    if (picked) {
      const base = picked.name.replace(/\.(md|markdown|txt)$/i, "");
      setRulesetName(`${base} Guardrails`);
    }
  };

  const handleExtract = async () => {
    setError("");
    if (!file && !pastedText.trim()) {
      setError("Upload a .md / .txt document or paste architecture notes first.");
      return;
    }
    setExtracting(true);
    try {
      let res;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        res = await axios.post(`${API}/guardrails/generate-from-doc`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      } else {
        res = await axios.post(`${API}/guardrails/generate-from-doc`, {
          content: pastedText,
          filename: "architecture-notes.md",
        });
      }
      const rules = res.data?.rules || [];
      setExtracted(rules);
      const sel = {};
      rules.forEach((r) => { sel[r.id] = true; });
      setSelected(sel);
    } catch (err) {
      setError(err.response?.data?.detail || err.message || "Failed to extract rules.");
    } finally {
      setExtracting(false);
    }
  };

  const updateRule = (id, patch) => {
    setExtracted((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleSave = async () => {
    const chosen = (extracted || []).filter((r) => selected[r.id]);
    if (chosen.length === 0) {
      setError("Select at least one rule to save.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (targetProfileId === "new") {
        await axios.post(`${API}/guardrails`, {
          name: rulesetName.trim() || "ADR Guardrails",
          description: `Compiled from ${file ? file.name : "architecture notes"}`,
          rules: chosen,
        });
      } else {
        const existing = saved.find((g) => g.id === targetProfileId);
        const merged = [...(existing?.rules || []), ...chosen];
        await axios.put(`${API}/guardrails/${targetProfileId}`, {
          rules: merged,
        });
      }
      onToast(`Saved ${chosen.length} guardrail rule(s).`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.detail || err.message || "Failed to save rules.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-emerald-800/70 bg-[#111111] p-6 mb-6" data-testid="import-doc-panel">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-emerald-400" />
          <h3 className="text-sm font-[Chivo] font-bold text-white uppercase tracking-widest">
            Import Guardrails from ADR / LLD / HLD
          </h3>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-white" data-testid="import-doc-close">
          <X size={16} />
        </button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 border border-red-800 bg-red-950/40 text-red-300 text-xs font-mono">
          {error}
        </div>
      )}

      {extracted === null ? (
        <>
          <p className="text-xs text-zinc-400 mb-4">
            Upload an architecture decision record (ADR), LLD, or HLD (<code>.md</code> / <code>.txt</code>) or paste notes below.
            Gemini will extract enforceable must / must-not rules for you to review before saving.
          </p>
          <div className="mb-4">
            <label className="flex items-center gap-3 px-4 py-3 border border-dashed border-zinc-700 bg-[#0A0A0A] hover:border-emerald-500 cursor-pointer">
              <Upload size={15} className="text-emerald-400 shrink-0" />
              <span className="text-xs font-mono text-zinc-300 truncate">
                {file ? `Selected: ${file.name} (${Math.ceil(file.size / 1024)} KB)` : "Choose .md or .txt file…"}
              </span>
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={handleFileChange}
                className="hidden"
                data-testid="import-doc-file-input"
              />
            </label>
          </div>
          <div className="mb-4">
            <p className="text-[11px] font-mono text-zinc-500 uppercase mb-1.5 tracking-wider">
              Or paste architecture notes
            </p>
            <textarea
              rows={6}
              value={pastedText}
              onChange={(e) => { setPastedText(e.target.value); if (file) setFile(null); }}
              placeholder={"# ADR-004: API & Security Rules\n- Services MUST NOT use SELECT * in SQL queries.\n- All outbound HTTP calls MUST define an explicit timeout."}
              data-testid="import-doc-textarea"
              className="w-full bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-xs text-zinc-400 hover:text-white">
              Cancel
            </button>
            <button
              onClick={handleExtract}
              disabled={extracting}
              data-testid="extract-doc-rules-btn"
              className="flex items-center gap-2 px-5 py-2 bg-emerald-400 text-black text-xs font-bold hover:bg-emerald-300 disabled:opacity-50"
            >
              <Sparkles size={13} />
              {extracting ? "Extracting rules…" : "Extract Rules"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-mono text-zinc-400">
              Extracted <span className="text-emerald-400 font-bold">{extracted.length}</span> rule(s). Review, edit, or uncheck before saving.
            </p>
            <button
              onClick={() => { setExtracted(null); setError(""); }}
              className="text-xs font-mono text-zinc-500 hover:text-white underline"
            >
              ← Back to upload
            </button>
          </div>

          {extracted.length === 0 ? (
            <div className="border border-zinc-800 p-6 text-center text-xs text-zinc-500 mb-4">
              No enforceable must / must-not rules were found in this document.
            </div>
          ) : (
            <div className="space-y-2 mb-4 max-h-96 overflow-y-auto pr-1">
              {extracted.map((rule) => {
                const isChecked = !!selected[rule.id];
                return (
                  <div
                    key={rule.id}
                    className={`border p-3 bg-[#0A0A0A] ${isChecked ? "border-zinc-700" : "border-zinc-900 opacity-50"}`}
                    data-testid={`extracted-rule-${rule.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => setSelected((p) => ({ ...p, [rule.id]: !p[rule.id] }))}
                        className="mt-1 text-zinc-300 hover:text-emerald-400"
                      >
                        {isChecked ? <CheckSquare size={16} /> : <Square size={16} />}
                      </button>
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            value={rule.name}
                            onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                            className="bg-[#111111] border border-zinc-800 text-white px-2 py-1 text-xs font-medium flex-1 min-w-[160px] focus:outline-none focus:ring-1 focus:ring-emerald-400"
                          />
                          <select
                            value={rule.severity}
                            onChange={(e) => updateRule(rule.id, { severity: e.target.value })}
                            className="bg-[#111111] border border-zinc-800 text-xs font-mono text-white px-2 py-1"
                          >
                            <option value="critical">critical</option>
                            <option value="warning">warning</option>
                            <option value="info">info</option>
                          </select>
                          <span className="text-[10px] font-mono text-zinc-400 border border-zinc-800 px-1.5 py-0.5">
                            {rule.type}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-500">
                            {rule.id}
                          </span>
                        </div>
                        <input
                          value={rule.description}
                          onChange={(e) => updateRule(rule.id, { description: e.target.value })}
                          className="w-full bg-[#111111] border border-zinc-800 text-zinc-300 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400"
                        />
                        {rule.type === "regex" && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-zinc-500 uppercase">pattern:</span>
                            <input
                              value={rule.pattern || ""}
                              onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
                              className="flex-1 bg-[#111111] border border-zinc-800 text-emerald-300 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 pt-3 border-t border-zinc-800">
            <div>
              <p className="text-[11px] font-mono text-zinc-500 uppercase mb-1">Destination Profile</p>
              <select
                value={targetProfileId}
                onChange={(e) => setTargetProfileId(e.target.value)}
                data-testid="import-target-profile"
                className="w-full bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-xs font-mono"
              >
                <option value="new">+ Create new ruleset</option>
                {saved.map((g) => (
                  <option key={g.id} value={g.id}>
                    Append to: {g.name} ({g.rules.length} rules)
                  </option>
                ))}
              </select>
            </div>
            {targetProfileId === "new" && (
              <div>
                <p className="text-[11px] font-mono text-zinc-500 uppercase mb-1">New Ruleset Name</p>
                <input
                  value={rulesetName}
                  onChange={(e) => setRulesetName(e.target.value)}
                  data-testid="import-ruleset-name"
                  className="w-full bg-[#0A0A0A] border border-zinc-800 text-white px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-xs text-zinc-400 hover:text-white">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || extracted.length === 0}
              data-testid="save-imported-rules-btn"
              className="px-5 py-2 bg-emerald-400 text-black text-xs font-bold hover:bg-emerald-300 disabled:opacity-50"
            >
              {saving ? "Saving…" : `Save Selected (${Object.values(selected).filter(Boolean).length})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SavedRulesetCard({ guardrails, onDelete, onExportYaml, onCopyPullCmd }) {
  const counts = guardrails.rules.reduce(
    (acc, r) => {
      acc[r.severity] = (acc[r.severity] || 0) + 1;
      return acc;
    },
    {}
  );
  return (
    <div
      className="border border-zinc-800 bg-[#111111] p-4 flex flex-col justify-between gap-3"
      data-testid={`saved-ruleset-${guardrails.id}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck size={14} className="text-emerald-400" />
            <span className="text-sm font-[Chivo] font-bold text-white truncate">{guardrails.name}</span>
          </div>
          <p className="text-xs text-zinc-500 mb-2">{guardrails.description || "—"}</p>
          <div className="flex items-center gap-3 text-xs font-mono text-zinc-500">
            <span>{guardrails.rules.length} rules</span>
            {counts.critical && <span className="text-red-400">{counts.critical} critical</span>}
            {counts.warning && <span className="text-amber-400">{counts.warning} warning</span>}
            {counts.info && <span className="text-cyan-400">{counts.info} info</span>}
          </div>
        </div>
        <button
          onClick={onDelete}
          className="text-zinc-600 hover:text-red-400 p-1"
          data-testid={`delete-ruleset-${guardrails.id}`}
          title="Delete ruleset"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/80 flex-wrap">
        <button
          onClick={() => onExportYaml(guardrails)}
          data-testid={`export-yaml-${guardrails.id}`}
          className="flex items-center gap-1.5 px-2.5 py-1 border border-zinc-800 bg-[#0A0A0A] text-zinc-300 hover:text-white hover:border-zinc-600 text-[11px] font-mono"
        >
          <Download size={12} /> Export YAML
        </button>
        <button
          onClick={() => onCopyPullCmd(guardrails)}
          data-testid={`copy-pull-cmd-${guardrails.id}`}
          className="flex items-center gap-1.5 px-2.5 py-1 border border-zinc-800 bg-[#0A0A0A] text-emerald-400 hover:text-emerald-300 hover:border-emerald-700 text-[11px] font-mono"
        >
          <Terminal size={12} /> Copy Local Pull Command
        </button>
      </div>
    </div>
  );
}

export default function Guardrails() {
  const [builtin, setBuiltin] = useState({ rules: [], presets: [] });
  const [saved, setSaved] = useState([]);
  const [building, setBuilding] = useState(false);
  const [importingDoc, setImportingDoc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((cur) => (cur === msg ? "" : cur));
    }, 3500);
  };

  const fetchAll = async () => {
    const [b, g] = await Promise.all([
      axios.get(`${API}/guardrails/builtin`),
      axios.get(`${API}/guardrails`),
    ]);
    setBuiltin(b.data);
    setSaved(g.data);
  };

  useEffect(() => { fetchAll(); }, []);

  const handlePickPreset = async (key) => {
    setBusy(true);
    try {
      await axios.post(`${API}/guardrails/from-preset`, { preset: key });
      await fetchAll();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this ruleset? Watched repos using it will be detached.")) return;
    await axios.delete(`${API}/guardrails/${id}`);
    fetchAll();
  };

  const handleExportYaml = async (guardrails) => {
    try {
      const res = await axios.get(`${API}/guardrails/${guardrails.id}/export.yml`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "text/yaml;charset=utf-8" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "repodoc.yml";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast(`Exported repodoc.yml (${guardrails.name})`);
    } catch {
      showToast("Failed to export YAML.");
    }
  };

  const handleCopyPullCmd = async (guardrails) => {
    const exportUrl = getExportUrl(guardrails.id);
    const cmd = `npx repodoc-local rules pull ${exportUrl}`;
    try {
      await navigator.clipboard.writeText(cmd);
      showToast("Copied local pull command to clipboard!");
    } catch {
      window.prompt("Copy this command to sync rules locally:", cmd);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8" data-testid="guardrails-page">
      {toastMsg && (
        <div
          data-testid="guardrails-toast"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 border border-emerald-600 bg-[#0F1A14] text-emerald-300 text-xs font-mono shadow-lg"
        >
          <Check size={14} className="text-emerald-400 shrink-0" />
          <span>{toastMsg}</span>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-[Chivo] font-bold text-white tracking-tight">Guardrails</h1>
          <p className="text-zinc-500 text-sm mt-1">
            Define organizational coding rules. Every new commit is evaluated before bad code spreads.
          </p>
        </div>
        <button
          onClick={fetchAll}
          className="p-2 border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-900"
          data-testid="guardrails-refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <h2 className="text-xs font-[Chivo] font-bold text-zinc-500 uppercase tracking-widest mb-3">
        Quick Start — Presets
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        {builtin.presets.map((p) => (
          <PresetCard key={p.key} preset={p} onPick={handlePickPreset} busy={busy} />
        ))}
      </div>

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-xs font-[Chivo] font-bold text-zinc-500 uppercase tracking-widest">
          Saved Rulesets ({saved.length})
        </h2>
        <div className="flex items-center gap-2">
          {!importingDoc && (
            <button
              onClick={() => { setImportingDoc(true); setBuilding(false); }}
              data-testid="open-import-doc-btn"
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-400 text-black text-xs font-bold hover:bg-emerald-300"
            >
              <FileText size={12} /> Import from ADR / LLD / HLD
            </button>
          )}
          {!building && (
            <button
              onClick={() => { setBuilding(true); setImportingDoc(false); }}
              data-testid="open-builder-btn"
              className="flex items-center gap-2 px-3 py-1.5 bg-white text-black text-xs font-bold hover:bg-zinc-200"
            >
              <Plus size={12} /> Build Custom
            </button>
          )}
        </div>
      </div>

      {importingDoc && (
        <ImportFromDocPanel
          saved={saved}
          onSaved={() => { setImportingDoc(false); fetchAll(); }}
          onClose={() => setImportingDoc(false)}
          onToast={showToast}
        />
      )}

      {building && (
        <div className="mb-6">
          <GuardrailsBuilder
            builtin={builtin}
            onSave={() => { setBuilding(false); fetchAll(); }}
            onClose={() => setBuilding(false)}
          />
        </div>
      )}

      {saved.length === 0 ? (
        <div className="border border-zinc-800 p-12 text-center">
          <ShieldCheck size={32} className="text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">No rulesets yet. Pick a preset, import from an ADR/LLD/HLD, or build a custom one.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {saved.map((g) => (
            <SavedRulesetCard
              key={g.id}
              guardrails={g}
              onDelete={() => handleDelete(g.id)}
              onExportYaml={handleExportYaml}
              onCopyPullCmd={handleCopyPullCmd}
            />
          ))}
        </div>
      )}
    </div>
  );
}
