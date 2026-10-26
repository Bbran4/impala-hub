# Smart Stock Import Format

Smart Stock imports require both a Stock Booking dataset and a Stock Reordering dataset. Administrators can provide two UTF-8 CSV/TSV files or two XLSX files. A combined XLSX workbook can be selected for both inputs; Impala Hub chooses the worksheet whose headers best match each dataset.

## File limits and safety

- Supported formats: `.csv`, `.tsv`, `.xlsx`.
- Maximum compressed file size: 25 MB per file.
- Maximum data rows: 100,000 per dataset.
- Maximum worksheet width: 100 used columns.
- Headers must appear within the first 20 rows and must be unique after case, punctuation and spacing are normalized.
- Excel formulas are rejected. Paste calculated values before importing.
- CSV text beginning with spreadsheet formula characters is rejected for text fields.
- Mixed CSV/XLSX pairs are rejected. Use two delimited files or two workbooks.
- Only `Part Number` is mandatory at the source-mapping layer. Numeric and database constraints still apply to every mapped value.

## Stock Booking columns

| Column | Type | Rules |
|---|---|---|
| Source ID | Text | Optional source identifier |
| Franchise | Text | Part of the duplicate key |
| Part Number | Text | Required; maximum 120 characters |
| Description | Text | Optional |
| Unit Size | Text | Optional |
| On Picking Slip ER | Integer | Zero or greater |
| QOH ER | Integer | Negative values allowed |
| Max ER | Integer | Zero or greater |
| On Picking Slip PTA | Integer | Zero or greater |
| QOH PTA | Integer | Negative values allowed |
| Max PTA | Integer | Zero or greater |
| QOH WH | Integer | Negative values allowed |
| Max WH | Integer | Zero or greater |
| Bin ER | Text | Optional |
| Bin PTA | Text | Optional |
| Bin WH | Text | Optional |

Impala Hub calculates Supply ER and Supply PTA during staging as `max(0, Max - QOH - On Picking Slip)`. Supplied values cannot override that calculation.

## Stock Reordering columns

| Column | Type | Rules |
|---|---|---|
| Source ID | Text | Optional source identifier |
| Franchise | Text | Part of the duplicate key |
| Part Number | Text | Required; maximum 120 characters |
| Description | Text | Optional |
| Alternative 1–4 | Text | Optional |
| QOH ER / PTA / WH | Decimal | Negative values allowed; maximum four decimal places |
| Safety ER / PTA / WH | Decimal | Zero or greater; maximum four decimal places |
| Global Safety | Decimal | Zero or greater; maximum four decimal places |
| Qty on Order | Decimal | Zero or greater; maximum four decimal places |
| Qty to Order | Decimal | Zero or greater; maximum four decimal places |
| Lead Time | Text | Optional |
| Average Sales | Decimal | Negative values allowed; maximum four decimal places |
| Sales This Month | Decimal | Negative values allowed; maximum four decimal places |
| Gauge | Text | Optional |
| Supplier | Text | Optional |
| Last Cost | Decimal | Blank or zero and greater; maximum two decimal places |
| Supplier Type | Text | Blank, `Local` or `International` |

## Mapping and duplicate rules

Header matching ignores case, spaces, underscores, hyphens and other punctuation. Common alternatives such as `Part No`, `Stock Code`, `Brand`, `QOH ER`, `Warehouse QOH`, `Vendor`, and `Avg Sales` are detected automatically. Administrators must review the mapping before staging.

Within each dataset, `Franchise + Part Number` must be unique after trimming and case normalization. Unknown columns remain unmapped and are not imported.

## Import workflow

1. Select both source files.
2. Review the selected worksheet, file checksum, mappings, errors and preview.
3. Select **Stage and validate**. No live stock data changes at this point.
4. Review the validated batch in Import History.
5. Select **Activate** and confirm. Supabase activates the new version and supersedes the previous snapshot in one transaction.
6. If an upload is interrupted, reject the staged attempt before retrying the same files.
