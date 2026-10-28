# Reporting apps — user guide

Reporting replaces the parts of Qlik Sense that Impala uses: apps with a data model, dashboard sheets,
charts and tables with calculations, and selections that filter everything at once.

Data comes from the ERP through the Impala BI sync agent (see `bi-agent/README.md`). Apps only ever read
those loaded tables.

## Who can do what

| Role | Can |
|---|---|
| `administrator` | Everything, including the data loader (Data Loads, Run History, Audit Log) |
| `report_builder` | Create, edit and delete apps and sheets; choose who can open each app |
| everyone else | Open the apps shared with one of their roles or with them by name, and use selections |

Give someone the builder role in the Supabase SQL editor:
```sql
insert into public.profile_roles (profile_id, role_id)
select id, 'report_builder' from public.profiles where email = 'someone@impalaspares.co.za';
```

## Concepts (same as Qlik)

- **App**: a data model, a set of master measures, a list of sheets and an access list.
- **Data model**: the loaded tables the app uses and how they link. One table is the **main table**, the one
  whose rows you count and add up (for sales: invoice lines). Every other table links to the main table, or to
  a table already linked, on one or more matching fields. Same-named fields are suggested, and key-like
  ones (`*_no`, `*_code`, `*_id`) are linked automatically when you add a table. Charts only join the tables
  they actually use.
- **Sheet**: one dashboard page. Objects sit on a 24-column grid; drag the header to move, the bottom-right
  corner to resize.
- **Selections**: clicking a bar, slice, table cell, legend entry or filter-pane value filters every object in
  the app, on every sheet. Ctrl+click adds to a selection. The bar under the sheet tabs shows the current
  selections; clear them one by one or all at once. Filter panes keep showing all values of their own field
  so you can pick more.

## Objects

| Object | Dimensions | Measures | Notes |
|---|---|---|---|
| KPI | – | 1–2 | Big number; the second measure shows underneath |
| Bar chart | 1–2 | 1–4 | A second dimension splits each bar (grouped, or stacked); more than 14 categories turn horizontal |
| Line chart | 1–2 | 1–4 | A second dimension draws one line per value |
| Pie chart | 1 | 1 | Top 7 slices, the rest are "Other" |
| Table | 0–10 | 0–20 | Click headers to sort, totals row, loads 200 rows at a time, CSV export (up to 10,000 rows) |
| Pivot table | 2–4 | 1–4 | The last dimension becomes the columns |
| Filter pane | 1 | – | Searchable list of values |
| Text | – | – | Headings and notes |

Every object can have **conditions**: row filters that only apply to that object, e.g.
`invoice_date = Today() - 1` for "yesterday" reports.

## Expressions

Dimensions are usually a field (`branch`, `[Cost Price]`, `invoices.branch` if two tables share the
name) but can be calculated (`Year(invoice_date)`, `YearMonth(invoice_date)`). Measures must aggregate.

| | |
|---|---|
| Aggregations | `Sum(x)` `Avg(x)` `Min(x)` `Max(x)` `Median(x)` `Count(x)` `Count(DISTINCT x)` `Count(*)` |
| Arithmetic | `+ - * /` (dividing by zero gives an empty value), `&` joins text |
| Comparisons | `= <> < <= > >=` with `and`, `or`, `not` |
| Logic | `If(condition, then, else)`, `Alt(value, fallback)` |
| Numbers | `Round(x, decimals)`, `Abs(x)`, `Num(x)` |
| Text | `Upper` `Lower` `Trim` `Len` `Left(x, n)` `Right(x, n)` `Text(x)` |
| Dates | `Today()` `Now()` `Date(x)` `Year` `Quarter` `Month` `Week` `Day` `WeekDay` `MonthStart` `WeekStart` `YearStart` `YearMonth` |
| Literals | numbers `12.5`, text `'Centurion'` (double a quote to include one: `'it''s'`), `null` |

**Master measures** are defined once per app (Data model & sharing) and used as `[Name]`, for example:

| Name | Expression | Format |
|---|---|---|
| Sales | `Sum(qty * unit_price)` | Rand |
| Cost | `Sum(qty * cost_price)` | Rand |
| Gross profit | `[Sales] - [Cost]` | Rand |
| Margin % | `([Sales] - [Cost]) / [Sales]` | Percent |
| Invoices | `Count(DISTINCT invoices.invoice_no)` | Whole number |

Expressions are checked as you type: unknown fields, missing brackets and measures without an
aggregation are reported before anything runs.

## Security

- The browser never sends SQL. Expressions are parsed into a syntax tree in the browser, and the database
  (`bi.compile_expr`) turns that tree into SQL using only the functions and operators listed above, quoted
  field names that must exist in the app's data model, and quoted literal values.
- Every query checks that the user may open that app (`bi.can_view_app`). Users can only reach the
  tables in the app's data model; the loaded data in `bi_data` is never readable directly.
- Queries time out after 20 seconds and return at most 10,000 rows.
- Creating, changing and deleting apps is recorded in the Reporting audit log.
- Not yet available: row-level access within an app (Qlik section access, e.g. "own branch only").
  Until then, share apps only with people who may see all of their data.
