# Reporting apps — user guide

Reporting replaces the parts of Qlik Sense that Impala uses: apps with a data model, dashboard sheets,
charts and tables with calculations, and selections that filter everything at once.

Data comes from the ERP through the Impala BI sync agent (see `bi-agent/README.md`), plus any **data
connections** for data that is not in the ERP (Excel/CSV uploads, web APIs, files in a folder). Apps only
ever read those loaded tables.

## Who can do what

| Role | Can |
|---|---|
| `administrator` | Everything, including the data loader (Data Connections, Data Loads, Run History, Audit Log) |
| `report_builder` | Create, edit and delete apps and sheets; choose who can open each app |
| everyone else | Open the apps shared with one of their roles or with them by name, and use selections |

Give someone the builder role in the Supabase SQL editor:
```sql
insert into public.profile_roles (profile_id, role_id)
select id, 'report_builder' from public.profiles where email = 'someone@impalaspares.co.za';
```

## Concepts (same as Qlik)

- **App**: a data model, a set of master measures, a list of sheets and an access list.
- **Data model**: the loaded tables the app uses and how they link, like Qlik's associations. There is no
  main table: every table is linked to another on one or more matching key fields, and links work both
  ways. Same-named fields are suggested, and key-like ones (`*_no`, `*_code`, `*_id`) are linked
  automatically when you add a table. Each table's **Linked to** can be changed after it is added; the links
  cannot form a loop. Charts only join the tables they use (plus the ones that connect them), and records
  without a match are kept: stock items that never sold still appear in a stock chart, and selections
  narrow them like any other record.
- **Sheet**: one dashboard page. Objects sit on a 24-column grid; drag the header to move, the bottom-right
  corner to resize.
- **Selections**: clicking a bar, slice, table cell, legend entry or filter-pane value filters every object in
  the app, on every sheet. Ctrl+click adds to a selection. The bar under the sheet tabs shows the current
  selections; clear them one by one or all at once. Filter panes keep showing all values of their own field
  so you can pick more.

## Data model viewer

**Reporting → Data Model** draws the loaded tables as boxes with their fields, like Qlik's data model
viewer. With *All loaded tables*, a line joins fields with the same name in different tables (by default
only key-like ones: `*_code`, `*_no`, `*_id`; untick to see every shared field), which shows what apps
can link on. Choose *App: …* to see the links that app actually uses. Click a table's title for its fields
and connections, hover a field to follow it to the other tables, and drag titles to rearrange. Each table
shows where it comes from (ERP, upload, web, folder) and its row count.

The same diagram is under an app's **Data model & sharing → Show diagram**.

## Data connections (administrators)

**Reporting → Data Connections** adds tables that do not come from the ERP. The ERP load itself is
unchanged: it is defined in `tables.toml` on the agent machine and cannot be changed from the web.
Connection tables cannot use the name of an ERP table.

- **Upload Excel or CSV**: pick a `.xlsx`/`.csv` file, choose the sheet, check the column names and types
  (guessed from the data: text, whole number, number, date, date and time, yes/no), and load. The file is
  read in your browser and sent in chunks; nothing is stored except the table. Up to 1,000,000 rows and 300
  columns. Use **Replace file** to load a new version (the old table is swapped out in one step).
- **Web API**: a web address returning JSON or CSV that the agent fetches on a schedule. *Records path*
  points at the list inside the JSON (e.g. `data.items`); nested objects become columns like `meta_zone`.
  API keys are never typed into the hub: a header value like `Bearer ${COURIER_KEY}` is filled in by the
  agent from its own `.env`, and only for the host its `config.toml` allows.
- **Files from a folder**: Excel or CSV files in a folder the agent can read (e.g. a shared network folder
  with branch targets). Folders are chosen by name from the agent's `config.toml`; a pattern like
  `targets *.xlsx` picks the files. Use the newest matching file, or combine all of them (adds a
  `source_file` column).

Web and folder connections show their status (waiting, loading, loaded, failed with the error) and can be
reloaded straight away. The agent's `config.toml` `[connectors]` section decides which hosts, folders and
keys are allowed (see `bi-agent/README.md`); the page shows what each agent allows. Loaded connection
tables appear in **Data** and **Data Model** and are added to apps like any other table.

## Objects

| Object | Dimensions | Measures | Notes |
|---|---|---|---|
| KPI | – | 1–2 | Big number; the second measure shows underneath |
| Bar chart | 1–2 | 1–4 | A second dimension splits each bar (grouped, or stacked); more than 14 categories turn horizontal |
| Line chart | 1–2 | 1–4 | A second dimension draws one line per value |
| Pie chart | 1 | 1 | Top 7 slices, the rest are "Other" |
| Combo chart | 1 | 2–6 | First measure(s) as bars, the rest as lines; lines can use a second (right) axis |
| Scatter plot | 1 | 2–3 | One point per value: x, y and an optional bubble size |
| Gauge | – | 1–2 | One value on a half-circle; second measure is the target; minimum/maximum in Chart options |
| Bullet chart | 0–1 | 1–3 | Value bar, target marker (second measure) and range (third) |
| Funnel chart | 1 | 1 | Stages from largest to smallest with % of the first stage |
| Waterfall chart | 1 | 1 | How each value moves a running total; total bar at the end |
| Treemap | 1–2 | 1 | Rectangles sized by value; a second dimension nests inside the first |
| Histogram | 1 | – | Counts of a number field in ranges; number of bars in Chart options |
| Box plot | 1–2 | 1 | Median, quartiles, whiskers and outliers; with two dimensions one box per value of the first |
| Distribution plot | 1–2 | 1 | Every value as a dot, with the median |
| Radar chart | 1–2 | 1–4 | One axis per value of the first dimension (3 or more values) |
| Mekko chart | 2 | 1 | Column width = total per first dimension; segments = share of the second |
| Grid chart | 2 | 1 | Heat map: first dimension down, second across |
| Word cloud | 1 | 1 | Values sized by the measure |
| Table | 0–10 | 0–20 | Click headers to sort, totals row, loads 200 rows at a time, CSV export (up to 10,000 rows); column order and cell colours |
| Pivot table | 2–4 | 1–4 | The last dimension becomes the columns; cell colours per measure |
| Filter pane | 1 | – | Searchable list of values |
| Date picker | 1 (a date field) | – | Select a date range, or Today / Yesterday / This week / Last 7 days / This month / Last month / This year |
| Variable input | – | – | Change a variable with a text box, a dropdown or buttons |
| Slider | – | – | Change a number variable (minimum, maximum, step) |
| Button | 0–1 | – | Clear selections, select values in a field, set a variable, go to a sheet or open a web page |
| Navigation menu | – | – | A button per sheet |
| Tab container | – | – | Objects from the sheet shown one per tab (their titles are the tab names) |
| Layout container | – | – | Objects from the sheet side by side or stacked in one frame |
| Trellis container | 1 | – | Repeats one object for each value of the dimension (up to 24 panels) |
| P&L pivot | 1–2 | 1–4 | Rows in your order with styles (bold, header, line, indent, highlight, hidden); a second dimension becomes columns plus a Total |
| Variance waterfall | 1 | 2 | From the second measure's total (budget, last year) to the first's (actual), one step per value |
| Sankey chart | 2–4 | 1 | Flows from one dimension to the next |
| Network chart | 2 | 0–1 | Links between two dimensions (from → to); a measure sets the weight |
| Org chart | 2–3 | 0–1 | A tree from a node and its parent; parents that are not rows (e.g. a top level) are added |
| Map | 1 | 2–3 | Points by latitude and longitude, optional bubble size; OpenStreetMap background (can be switched off) |
| Animator | 1 | – | Plays through the values of a dimension (selects each in turn) |
| Insights | 1 | 1 | Written findings: total, highest and lowest, share, above average, latest and biggest change (calculated, no AI service) |
| Write table | 1–6 | 0–10 | A table with editable columns (text, number, choice) saved per row for everyone; optionally builders only |
| Text | – | – | Headings and notes |
| Text & image | – | – | A note with a picture on the left, right or top |
| Image | – | – | A picture from an https address |
| Line | – | – | A horizontal or vertical divider (colour, thickness) |
| Video player | – | – | YouTube or Vimeo (embedded without tracking cookies) or an https video file |

Straight table = Table, pivot table = Pivot table. Every chart supports click-to-select. The object list in
edit mode has a search box.

**Order.** Drag dimensions and measures by their grip (⋮⋮) in the side panel, or focus the grip and press
Alt+↑/↓. The first dimension is the chart's axis and the order of measures is the order of bars, lines and
columns. In a table, **Column order** can put any column first, including a measure before the dimensions.

**Cell colours.** In tables and pivot tables (every dimension and measure), open **Colours** under a column and
write a background and/or text colour expression. It is calculated per row like a measure, e.g.
`If(Sum(qty_on_hand) < 30, '#fbe3dd')`, `If(qty_on_hand < 30, 'red', 'green')`, `RGB(27, 175, 122)` or
`ColorMix1(Sum(qty) / 1000, '#ffffff', '#2a78d6')`. Results that are not a colour (a name, `#rrggbb` or
`rgb(…)`) are ignored; text on a coloured background is made dark or white automatically.

In a pivot table, a dimension's colour colours its header cells: row headers per row, column headers per
column.

**Variables.** Define them under Data model & sharing → Variables (name, starting value, description) and
use them in any expression or object title as `$(name)`, like Qlik's dollar expansion: the text of the
variable is put in before the expression is read, e.g. `qty_on_hand < $(vMinStock)`,
`branch = '$(vBranch)'` (quotes for text) or a whole expression such as `$(vSalesExpr)`. Variable inputs,
sliders and buttons change the value for the person looking at the app; everyone starts from the saved
value. The expression box suggests variables as you type.

**Write tables.** Values typed into a write table are stored in Reporting (`bi.write_cells`, per app, object,
row and column), never in the loaded ERP data. A row is identified by its dimension values, so keep the
dimensions stable (renaming a column or changing the dimensions starts those cells empty). The CSV export
includes the typed columns. Saving the sheet is needed before people can type in a new write table.

**Containers.** Add the objects to the sheet first, then pick them in the container's settings; they are
hidden from the sheet and shown in the container ("Edit" opens their settings, × puts them back).

Rows where every measure is empty are left out (like Qlik), e.g. a branch value that only exists because a
stock item never sold.

Every object can have **conditions**: row filters that only apply to that object, e.g.
`invoice_date = Today() - 1` for "yesterday" reports.

## Expressions

Dimensions are usually a field (`branch`, `[Cost Price]`, `invoices.branch` if two tables share the
name) but can be calculated (`Year(invoice_date)`, `YearMonth(invoice_date)`). Measures combine records with an
aggregation; a field on its own in a measure means `Only(field)`, as in Qlik (its value when every record
in the chart row has the same value, otherwise empty), so `reorder_level - qty_on_hand` works in a table
per item.

There are 71 functions (aggregation, text, number, date and logic) plus `&` to join text and `//` or
`/* */` comments. The full list with examples is in [REPORTING_FUNCTIONS.md](REPORTING_FUNCTIONS.md) and in
the app under **Reporting → Function Reference**. A few common ones:

| | |
|---|---|
| Aggregations | `Sum(x)` `Avg(x)` `Count(DISTINCT x)` `Count(*)` `Concat(DISTINCT x, ', ')` `Only(x)` |
| Text | `branch & ' - ' & item_code` `Upper` `Left(x, n)` `Mid(x, start, n)` `Replace(x, from, to)` `SubField(x, '-', 2)` |
| Numbers | `Round(x, 2)` `Floor` `Ceil` `Mod` `RangeSum(a, b)` |
| Dates | `Today()` `YearMonth(d)` `MonthStart(d)` `AddMonths(d, n)` `DaysBetween(a, b)` |
| Logic | `If(condition, then, else)` `Alt(value, fallback)` `Match(x, 'a', 'b')` `WildMatch(x, 'BOSCH*')` `Pick(n, a, b)` |

**How records are counted.** Like Qlik, every aggregation counts each record of the tables it uses
once. In an app with invoice lines and stock items linked on `item_code`, `Sum(qty_on_hand)` adds each
item's stock once (not once per invoice line it appears on), `Sum(qty)` adds every invoice line, and
`Sum(qty * cost_price)` works per invoice line because it uses both tables. `Count(*)` counts records of
the table chosen under **Count(*) counts records of** in the data model; `Count(DISTINCT item_code)` counts
anything else.

**Writing expressions.** Every expression box suggests master measures, fields and functions as you
type (↑ ↓ and Enter insert at the cursor). The expand button opens a large editor with line numbers,
errors by line and column, a searchable function list with examples, and **Test**, which runs the
expression against the app's data. Ctrl+Enter applies it.

**Master measures** are defined once per app (Data model & sharing) and used as `[Name]`, for example:

| Name | Expression | Format |
|---|---|---|
| Sales | `Sum(qty * unit_price)` | Rand |
| Cost | `Sum(qty * cost_price)` | Rand |
| Gross profit | `[Sales] - [Cost]` | Rand |
| Margin % | `([Sales] - [Cost]) / [Sales]` | Percent |
| Invoices | `Count(DISTINCT invoices.invoice_no)` | Whole number |

Expressions are checked as you type: unknown functions, wrong numbers of arguments, unknown fields,
missing brackets and measures without an aggregation are reported before anything runs.

New functions are added in one place, `frontend/src/biFunctions.ts`, plus the SQL in a migration
(`bi.compile_expr`). `npm test` fails if a function is missing from the migration, the generated database
tests (`scripts/gen-function-tests.mjs`) or the generated docs (`scripts/gen-function-docs.mjs`).

## Security

- The browser never sends SQL. Expressions are parsed into a syntax tree in the browser, and the database
  (`bi.compile_expr`) turns that tree into SQL using only the functions and operators listed above, quoted
  field names that must exist in the app's data model, and quoted literal values.
- Every query checks that the user may open that app (`bi.can_view_app`). Users can only reach the
  tables in the app's data model; the loaded data in `bi_data` is never readable directly.
- Queries time out after 20 seconds and return at most 10,000 rows.
- Creating, changing and deleting apps is recorded in the Reporting audit log, as are uploads and
  connection changes (without header values).
- Data connections can only be managed by administrators. Uploaded values are checked against the
  column types in the database; table and column names are checked against a fixed pattern. Web and
  folder connections run on the agent, which only reaches the hosts and folders its own config allows.
- Not yet available: row-level access within an app (Qlik section access, e.g. "own branch only").
  Until then, share apps only with people who may see all of their data.
