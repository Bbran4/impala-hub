import { useEffect, useState } from "react";
import { Search, RefreshCw, PackageSearch } from "lucide-react";
import { API } from "./lib";
type Props = {
  token: string;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
};
type Item = {
  id: string;
  franchise: string;
  part_number: string;
  description: string;
  alt_1: string;
  alt_2: string;
  alt_3: string;
  alt_4: string;
  qoh_er: number;
  safety_er: number;
  qoh_pta: number;
  safety_pta: number;
  qoh_wh: number;
  safety_wh: number;
  global_safety: number;
  qty_on_order: number;
  qty_to_order: number;
  lead_time: string;
  avg_sales: number;
  sales_this_month: number;
  gauge: string;
  supplier: string;
  last_cost: number | null;
  supplier_type: string;
};
async function request<T>(token: string, path: string): Promise<T> {
  const response = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.detail || "Stock Reordering request failed");
  return body;
}
const money = (value: number | null) =>
  value == null ? "—" : `R${value.toFixed(2)}`;
export default function StockReordering({ token, setNotice, setError }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [supplierType, setSupplierType] = useState("");
  const [moverFilter, setMoverFilter] = useState<"all" | "slow" | "ab">("all");
  const [supplyFilter, setSupplyFilter] = useState<25 | 50 | null>(null);
  const [slowMax, setSlowMax] = useState(() =>
    Number(localStorage.getItem("stock_slow_max_avg_sales") || 2),
  );
  const [abMin, setAbMin] = useState(() =>
    Number(localStorage.getItem("stock_ab_min_avg_sales") || 10),
  );
  const [sort, setSort] = useState<{
    key: keyof Item;
    direction: "asc" | "desc";
  }>({ key: "part_number", direction: "asc" });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const query = new URLSearchParams({ search, supplier_type: supplierType });
      setItems(
        await request<Item[]>(token, `/api/stock-reordering/items?${query}`),
      );
      setError("");
      setNotice("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [token]);
  const filtered = [...items]
    .filter(
      (item) => {
        const supply = item.global_safety
          ? ((item.qoh_er + item.qoh_pta + item.qoh_wh) / item.global_safety) * 100
          : 0;
        const matchesMover = moverFilter === "all" || (moverFilter === "slow" ? item.avg_sales <= slowMax : item.avg_sales >= abMin);
        return matchesMover && (supplyFilter === null || supply <= supplyFilter);
      },
    )
    .sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const result = String(av ?? "").localeCompare(
        String(bv ?? ""),
        undefined,
        { numeric: true },
      );
      return sort.direction === "asc" ? result : -result;
    });
  const header = (label: string, key: keyof Item) => (
    <th
      data-sort={key}
      onClick={() =>
        setSort((current) =>
          current.key === key
            ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
            : { key, direction: "asc" },
        )
      }
    >
      {label}
      {sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
  return (
    <section className="rfq-workspace">
      <div className="sd-session-bar">
        <PackageSearch size={18} />
        <span>Smart Stock Control workspace</span>
        <div className="sd-view-tabs">
          <button className="active">Stock Reordering</button>
        </div>
      </div>
      <div className="rfq-toolbar buyouts-toolbar">
        <label className="rfq-search">
          <Search size={15} />
          Search
          <input
            placeholder="Search part number, description, supplier, or alt number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Supplier type
          <select
            value={supplierType}
            onChange={(e) => setSupplierType(e.target.value)}
          >
            <option value="">All suppliers</option>
            <option value="local">Local suppliers</option>
            <option value="international">International suppliers</option>
          </select>
        </label>
        <div className="stock-mover-actions">
          <span>Avg sales thresholds</span>
          <button
            className={moverFilter === "ab" ? "secondary active" : "secondary"}
            onClick={() => setMoverFilter(moverFilter === "ab" ? "all" : "ab")}
          >
            A&amp;B Movers ≥ {abMin}
          </button>
          <button
            className={
              moverFilter === "slow" ? "secondary active" : "secondary"
            }
            onClick={() =>
              setMoverFilter(moverFilter === "slow" ? "all" : "slow")
            }
          >
            Slow Movers ≤ {slowMax}
          </button>
        </div>
        <div className="stock-mover-actions">
          <span>Supply %</span>
          <button className={supplyFilter === 25 ? "secondary active" : "secondary"} onClick={() => setSupplyFilter(supplyFilter === 25 ? null : 25)}>25% or less</button>
          <button className={supplyFilter === 50 ? "secondary active" : "secondary"} onClick={() => setSupplyFilter(supplyFilter === 50 ? null : 50)}>50% or less</button>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      <div className="rfq-table-wrap">
        <table className="rfq-table stock-reordering-table">
          <thead>
            <tr>
              {header("Franchise", "franchise")}
              {header("Part Number", "part_number")}
              {header("Description", "description")}
              <th>Alt 1</th>
              <th>Alt 2</th>
              <th>Alt 3</th>
              <th>Alt 4</th>
              {header("QOH ER", "qoh_er")}
              {header("Safety ER", "safety_er")}
              {header("QOH PTA", "qoh_pta")}
              {header("Safety PTA", "safety_pta")}
              {header("QOH WH", "qoh_wh")}
              {header("Safety WH", "safety_wh")}
              {header("Global Safety", "global_safety")}
              <th>Supply %</th>
              {header("Qty on Order", "qty_on_order")}
              {header("Qty to Order", "qty_to_order")}
              {header("Lead Time", "lead_time")}
              {header("Avg Sales", "avg_sales")}
              {header("Sales this month", "sales_this_month")}
              {header("Gauge", "gauge")}
              {header("Supplier", "supplier")}
              {header("Last cost", "last_cost")}
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const supply = item.global_safety
                ? ((item.qoh_er + item.qoh_pta + item.qoh_wh) /
                    item.global_safety) *
                  100
                : 0;
              return (
                <tr className="rfq-data-row" key={item.id}>
                  <td>{item.franchise || "—"}</td>
                  <td>{item.part_number}</td>
                  <td>{item.description}</td>
                  <td>{item.alt_1 || "—"}</td>
                  <td>{item.alt_2 || "—"}</td>
                  <td>{item.alt_3 || "—"}</td>
                  <td>{item.alt_4 || "—"}</td>
                  <td>{item.qoh_er}</td>
                  <td>{item.safety_er}</td>
                  <td>{item.qoh_pta}</td>
                  <td>{item.safety_pta}</td>
                  <td>{item.qoh_wh}</td>
                  <td>{item.safety_wh}</td>
                  <td>{item.global_safety}</td>
                  <td>{supply.toFixed(1)}%</td>
                  <td>{item.qty_on_order}</td>
                  <td>{item.qty_to_order}</td>
                  <td>{item.lead_time || "—"}</td>
                  <td>{item.avg_sales}</td>
                  <td>{item.sales_this_month}</td>
                  <td>{item.gauge || "—"}</td>
                  <td>{item.supplier || "—"}</td>
                  <td>{money(item.last_cost)}</td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={23}>
                  <div className="rfq-empty">
                    <PackageSearch size={28} />
                    <h3>No reordering records</h3>
                    <p>
                      Import or refresh the stock-reordering data to populate
                      this workspace.
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
