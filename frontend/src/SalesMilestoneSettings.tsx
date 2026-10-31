import { useCallback, useEffect, useState } from "react";
import { BarChart3, Percent, Trash2 } from "lucide-react";
import ColorPicker from "./ColorPicker";
import {
  readBrowserMilestones,
  validateMilestones,
  type MilestoneKind,
  type SalesMilestoneSettings,
} from "./milestoneSettings";
import {
  loadSalesMilestones,
  saveSalesMilestones,
} from "./salesMilestonesService";

export default function SalesMilestoneSettings({
  setNotice,
  setError,
}: {
  setNotice: (message: string) => void;
  setError: (message: string) => void;
}) {
  const [saved, setSaved] = useState<SalesMilestoneSettings | null>(null);
  const [draft, setDraft] = useState<SalesMilestoneSettings | null>(null);
  const [amounts, setAmounts] = useState({ sales: "", gp: "" });
  const [busy, setBusy] = useState(false);
  const [legacy] = useState(() => {
    try {
      return readBrowserMilestones(localStorage);
    } catch {
      return null;
    }
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const settings = await loadSalesMilestones();
      setSaved(settings);
      setDraft(settings);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [setError]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(settings = draft) {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await saveSalesMilestones(settings);
      setSaved(result);
      setDraft(result);
      setNotice("Sales and GP% milestones saved for all users.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function add(kind: MilestoneKind) {
    if (!draft || !amounts[kind].trim()) return;
    try {
      const items = validateMilestones(
        [...draft[kind], { value: Number(amounts[kind]), color: "#234e70" }],
        kind,
      );
      setDraft({ ...draft, [kind]: items });
      setAmounts({ ...amounts, [kind]: "" });
    } catch (error) {
      setError((error as Error).message);
    }
  }
  function edit(kind: MilestoneKind, index: number) {
    if (!draft) return;
    const next = window.prompt(
      kind === "sales" ? "Edit sales milestone amount" : "Edit GP% milestone",
      String(draft[kind][index].value),
    );
    if (next === null) return;
    try {
      if (!next.trim()) throw new Error("Enter a milestone value.");
      setDraft({
        ...draft,
        [kind]: validateMilestones(
          draft[kind].map((item, i) =>
            i === index ? { ...item, value: Number(next) } : item,
          ),
          kind,
        ),
      });
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <>
      {!saved ? (
        <section className="admin-settings-panel">
          <p>
            {busy
              ? "Loading shared milestones…"
              : "Milestone settings could not be loaded."}
          </p>
          {!busy && (
            <button className="secondary" onClick={() => void load()}>
              Retry
            </button>
          )}
        </section>
      ) : (
        <>
          <div className="sd-milestone-save-bar">
            <p>
              {dirty
                ? "You have unsaved milestone changes."
                : "Milestones are saved in Supabase and shared across all users."}
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm("Discard unsaved milestone changes?")
                )
                  void load();
              }}
            >
              Reload milestones
            </button>
            <button
              className="primary"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save milestones"}
            </button>
          </div>
          {!saved.configured && legacy && (
            <div className="sd-milestone-import">
              <p>
                Milestones from this browser were found. You can copy them into
                the shared settings.
              </p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm(
                      "Replace the unsaved milestone changes with the browser settings?",
                    )
                  )
                    void save({ ...saved, ...legacy });
                }}
              >
                Import and save browser milestones
              </button>
            </div>
          )}
          {(["sales", "gp"] as const).map((kind) => (
            <section
              className="admin-settings-panel sd-settings-card"
              key={kind}
            >
              <div className="section-head">
                <div>
                  <h2>
                    {kind === "sales"
                      ? "Monthly sales milestones"
                      : "GP% milestones"}
                  </h2>
                  <p>
                    {kind === "sales"
                      ? "Set sales targets and choose their dashboard colours."
                      : "Set percentage thresholds and their dashboard colours."}{" "}
                    Click Save milestones to apply your changes.
                  </p>
                </div>
                {kind === "sales" ? (
                  <BarChart3 size={19} />
                ) : (
                  <Percent size={19} />
                )}
              </div>
              <div className="sd-config-add">
                <input
                  aria-label={
                    kind === "sales"
                      ? "New sales milestone"
                      : "New GP% milestone"
                  }
                  type="number"
                  min={kind === "sales" ? "0.01" : "0"}
                  max={kind === "gp" ? "100" : undefined}
                  step="0.01"
                  placeholder={
                    kind === "sales"
                      ? "Add milestone amount"
                      : "Add GP% milestone"
                  }
                  value={amounts[kind]}
                  disabled={busy}
                  onChange={(event) =>
                    setAmounts({ ...amounts, [kind]: event.target.value })
                  }
                />
                <button
                  className="primary"
                  disabled={busy || !amounts[kind].trim()}
                  onClick={() => add(kind)}
                >
                  Add
                </button>
              </div>
              <div className="sd-milestone-list">
                {draft?.[kind].map((item, index) => (
                  <div className="sd-config-row" key={item.value}>
                    <div>
                      <b>
                        {kind === "sales"
                          ? "R" + item.value.toLocaleString()
                          : item.value + "%"}
                      </b>
                      <small>
                        {kind === "sales" ? "Sales target" : "GP% threshold"}
                      </small>
                    </div>
                    <div className="sd-actions">
                      <ColorPicker
                        label={`${kind === "sales" ? "Sales" : "GP%"} milestone ${item.value} colour`}
                        value={item.color}
                        disabled={busy}
                        onChange={(color) =>
                          setDraft({
                            ...draft,
                            [kind]: draft[kind].map((value, i) =>
                              i === index ? { ...value, color } : value,
                            ),
                          })
                        }
                      />
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => edit(kind, index)}
                      >
                        Edit
                      </button>
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Remove ${kind} milestone ${item.value}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            [kind]: draft[kind].filter((_, i) => i !== index),
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {draft?.[kind].length === 0 && (
                  <p className="hint">No milestones configured.</p>
                )}
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
