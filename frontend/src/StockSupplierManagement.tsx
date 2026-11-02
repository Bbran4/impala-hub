import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { supabase } from "./supabase";
type Props = { setNotice: (m: string) => void; setError: (m: string) => void };
type Supplier = {
  id: string;
  supplier_code: string;
  supplier_name: string;
  is_active: boolean;
};
export default function StockSupplierManagement({
  setNotice,
  setError,
}: Props) {
  const [rows, setRows] = useState<Supplier[]>([]),
    [form, setForm] = useState({ supplier_code: "", supplier_name: "" }),
    [editing, setEditing] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [sort, setSort] = useState<"supplier_code" | "supplier_name" | "is_active">(
      "supplier_code",
    ),
    [descending, setDescending] = useState(false),
    [page, setPage] = useState(0);
  const load = async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("stock_suppliers")
      .select("*")
      .order("supplier_code");
    if (error) setError(error.message);
    else setRows((data || []) as Supplier[]);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const result = String(a[sort]).localeCompare(
          String(b[sort]),
          undefined,
          { numeric: true },
        );
        return descending ? -result : result;
      }),
    [rows, sort, descending],
  );
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const shown = sorted.slice(page * pageSize, page * pageSize + pageSize);
  const header = (label: string, key: typeof sort) => (
    <th
      data-sort
      onClick={() => {
        if (sort === key) setDescending(!descending);
        else {
          setSort(key);
          setDescending(false);
        }
      }}
    >
      {label}
      <span className="stock-table-sort">
        {sort === key ? (descending ? "↓" : "↑") : "↕"}
      </span>
    </th>
  );
  const save = async () => {
    if (!supabase || !form.supplier_code.trim() || !form.supplier_name.trim()) {
      setError("Enter a supplier code and supplier name.");
      return;
    }
    const user = (await supabase.auth.getUser()).data.user;
    const result = editing
      ? await supabase
          .from("stock_suppliers")
          .update({ ...form, updated_by: user?.id })
          .eq("id", editing)
      : await supabase
          .from("stock_suppliers")
          .insert({ ...form, created_by: user?.id, updated_by: user?.id });
    if (result.error)
      setError(
        result.error.code === "23505"
          ? "That supplier code already exists."
          : result.error.message,
      );
    else {
      setNotice(editing ? "Supplier updated." : "Supplier added.");
      setEditing(null);
      setForm({ supplier_code: "", supplier_name: "" });
      await load();
    }
  };
  const toggle = async (row: Supplier) => {
    if (!supabase) return;
    const { error } = await supabase
      .from("stock_suppliers")
      .update({ is_active: !row.is_active })
      .eq("id", row.id);
    if (error) setError(error.message);
    else await load();
  };
  const remove = async (row: Supplier) => {
    if (!supabase || !window.confirm(`Delete ${row.supplier_code}?`)) return;
    const { error } = await supabase
      .from("stock_suppliers")
      .delete()
      .eq("id", row.id);
    if (error)
      setError(
        error.code === "23503"
          ? "Archive this supplier while it is assigned to parts."
          : error.message,
      );
    else await load();
  };
  return (
    <section className="rfq-workspace">
      <div className="sd-session-bar">
        <Plus size={18} />
        <span>Smart Stock Control workspace</span>
        <div className="sd-view-tabs">
          <button className="active">Suppliers</button>
        </div>
        <button className="secondary" onClick={() => void load()}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <div className="section-head">
        <h2>Suppliers</h2>
      </div>
      <div className="settings-card">
        <h3>{editing ? "Update supplier" : "Add supplier"}</h3>
        <div className="account-fields">
          <label>
            Supplier code
            <input
              value={form.supplier_code}
              onChange={(e) =>
                setForm({ ...form, supplier_code: e.target.value })
              }
            />
          </label>
          <label>
            Supplier name
            <input
              value={form.supplier_name}
              onChange={(e) =>
                setForm({ ...form, supplier_name: e.target.value })
              }
            />
          </label>
          <button className="primary" onClick={() => void save()}>
            {editing ? "Save changes" : "Add supplier"}
          </button>
          {editing && (
            <button
              className="secondary"
              onClick={() => {
                setEditing(null);
                setForm({ supplier_code: "", supplier_name: "" });
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {pages > 1 && (
        <div className="stock-table-pagination">
          <button
            className="secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {pages} · {rows.length} records
          </span>
          <button
            className="secondary"
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
      {loading ? (
        <p>Loading suppliers…</p>
      ) : (
        <div className="rfq-table-wrap">
          <table className="rfq-table">
            <thead>
              <tr>
                {header("Supplier code", "supplier_code")}
                {header("Supplier name", "supplier_name")}
                {header("Status", "is_active")}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <b>{row.supplier_code}</b>
                  </td>
                  <td>{row.supplier_name}</td>
                  <td>{row.is_active ? "Active" : "Archived"}</td>
                  <td>
                    <button
                      className="secondary"
                      onClick={() => {
                        setEditing(row.id);
                        setForm({
                          supplier_code: row.supplier_code,
                          supplier_name: row.supplier_name,
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => void toggle(row)}
                    >
                      {row.is_active ? "Archive" : "Activate"}
                    </button>
                    <button
                      className="icon-button danger"
                      onClick={() => void remove(row)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={4}>No suppliers have been created.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="stock-table-pagination">
          <button
            className="secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {pages} · {rows.length} records
          </span>
          <button
            className="secondary"
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
