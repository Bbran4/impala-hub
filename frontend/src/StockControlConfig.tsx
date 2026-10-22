import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { API } from "./lib";

type Location = {
  id: string;
  name: string;
  description?: string;
  vehicle_name?: string;
  supply_branch?: "" | "er" | "pta";
  color?: string;
};
type Props = {
  token: string;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
};
async function request<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(API + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail
              .map((item: any) => item?.msg || JSON.stringify(item))
              .join("; ")
          : "Location request failed";
    throw new Error(message);
  }
  return body;
}

export default function StockControlConfig({
  token,
  setNotice,
  setError,
}: Props) {
  const [slowMax, setSlowMax] = useState(() => Number(localStorage.getItem("stock_slow_max_avg_sales") || 2));
  const [abMin, setAbMin] = useState(() => Number(localStorage.getItem("stock_ab_min_avg_sales") || 10));
  const [locations, setLocations] = useState<Location[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [vehicleName, setVehicleName] = useState("");
  const [supplyBranch, setSupplyBranch] = useState("");
  const [color, setColor] = useState("#dff7ff");
  const [editing, setEditing] = useState<Location | null>(null);
  const [saving, setSaving] = useState(false);
  const load = async () => {
    try {
      setLocations(
        await request<Location[]>(token, "/api/stock-booking/locations"),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [token]);
  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        vehicle_name: vehicleName.trim(),
        supply_branch: supplyBranch,
        color,
      };
      if (editing)
        await request(token, `/api/stock-booking/locations/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      else
        await request(token, "/api/stock-booking/locations", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      setName("");
      setDescription("");
      setVehicleName("");
      setSupplyBranch("");
      setColor("#dff7ff");
      setEditing(null);
      setNotice("Stock location saved successfully.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (location: Location) => {
    if (!window.confirm(`Remove ${location.name}?`)) return;
    try {
      await request(token, `/api/stock-booking/locations/${location.id}`, {
        method: "DELETE",
      });
      setNotice("Stock location removed.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveThresholds = () => { localStorage.setItem("stock_slow_max_avg_sales", String(slowMax)); localStorage.setItem("stock_ab_min_avg_sales", String(abMin)); setNotice("Mover thresholds saved."); setError(""); };
  return (
    <section className="settings-page">
      <div className="section-head">
        <div>
          <h2>Stock Control configuration</h2>
          <p>
            Manage locations, optional branch vehicles, supply mappings, and
            highlight colors.
          </p>
        </div>
      </div>
      <div className="settings-card"><h3>Reordering thresholds</h3><p>Set the average-sales cutoffs used by the mover filters.</p><div className="inline-form stock-config-form"><label>Slow Movers: less than or equal to<input type="number" min="0" step="0.1" value={slowMax} onChange={e => setSlowMax(Number(e.target.value))} /></label><label>A&amp;B Movers: greater than or equal to<input type="number" min="0" step="0.1" value={abMin} onChange={e => setAbMin(Number(e.target.value))} /></label><button className="primary" onClick={saveThresholds}>Save thresholds</button></div></div><div className="settings-card">
        <h3>Locations</h3>
        <div className="inline-form stock-config-form">
          <input
            placeholder="Location code"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            placeholder="Vehicle location (optional)"
            value={vehicleName}
            onChange={(e) => setVehicleName(e.target.value)}
          />
          <select
            className="stock-config-select"
            value={supplyBranch}
            onChange={(e) => setSupplyBranch(e.target.value)}
          >
            <option value="">No branch supply mapping</option>
            <option value="er">Highlights Supply ER</option>
            <option value="pta">Highlights Supply PTA</option>
          </select>
          <label className="stock-color-field">
            Highlight color
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? (
              "Saving…"
            ) : editing ? (
              "Save changes"
            ) : (
              <>
                <Plus size={16} /> Add location
              </>
            )}
          </button>
          {editing && (
            <button
              className="secondary"
              disabled={saving}
              onClick={() => {
                setEditing(null);
                setName("");
                setDescription("");
                setVehicleName("");
                setSupplyBranch("");
                setColor("#dff7ff");
              }}
            >
              <X size={16} /> Cancel
            </button>
          )}
        </div>
        <div className="config-list">
          {locations.map((location) => (
            <div className="config-row" key={location.id}>
              <span>
                <b>{location.name}</b>
                {location.description ? ` — ${location.description}` : ""}
                {location.vehicle_name
                  ? ` · Vehicle: ${location.vehicle_name}`
                  : ""}
              </span>
              <div>
                <button
                  className="icon-button"
                  aria-label={`Edit ${location.name}`}
                  onClick={() => {
                    setEditing(location);
                    setName(location.name);
                    setDescription(location.description || "");
                    setVehicleName(location.vehicle_name || "");
                    setSupplyBranch(location.supply_branch || "");
                    setColor(location.color || "#dff7ff");
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove ${location.name}`}
                  onClick={() => void remove(location)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
