# Sales Desk: Cross Reference

Sales Desk → **Cross Reference** (next to Dashboard, RFQs and Analytics) finds a part from any number it is known by.
Everyone with the Sales Desk can search; only administrators can import. Migration: `0092_xref_cross_reference.sql`.

## Searching

Type in the search box (results appear as you type, from 2 characters):

| Searched on | How |
|---|---|
| Part number / SKU (ours) | whole number, the start of it, or (3+ characters) any part of it |
| OE numbers | same |
| Cross ref numbers | same |
| Description and title | every word typed must appear, in any order |

Numbers ignore case, spaces, dashes, slashes and dots: `1445119000`, `14 451190 00` and `14-451190-00` are the same.

**Matches** are the parts that list what was typed. **Linked parts** are parts that share any OE or cross ref
number (or SKU) with a part found by number — one step only. Example: Victor-Reinz lists OE 4955595 and 4025300,
Elring lists only 4025300. Searching 4955595 shows Victor-Reinz as a match and Elring as linked via 4025300.
Linking is skipped when more than 200 parts match by number (type more of the number). Description matches are
not linked further.

Results show Part number / SKU, Brand and Description, with a small line saying why the part was found.
Clicking a part opens everything on its import line: title, description, brand, warranty, OE and cross ref numbers
(click one to search it), specifications, packaging and the brand description.

## Import file (administrators)

Excel (.xlsx) or CSV. The first worksheet with a "Part number / SKU" column is used; the header row can be anywhere
above the data. **Template** in the import panel downloads an empty file with every column.

| Column | Notes |
|---|---|
| Part number /SKU | required; our part number |
| Brand | |
| Brand Description | stored once per brand; an empty cell keeps the brand's existing description |
| Title | short description |
| Description | full description |
| Warranty | text, e.g. `1 year` |
| OE numbers | separated with `;` |
| Cross ref Numbers | other brands' numbers for the same part, separated with `;` |
| Package Length / Width / Height (cm), Package Weight (kg) | numbers; a decimal comma is fine |
| Ekstra 1 … Ekstra n | `Label: value`, shown as a two-column table (split on the first `:`); any number of these columns |

Rules:
- A row **replaces** that part number completely (numbers, specs, sizes). Part numbers are matched ignoring case.
- Parts that are **not in the file stay** as they are.
- If a part number appears twice in one file, the later row is used.
- Rows without a part number, or with a package size that is not a number, are skipped and listed.
- The panel shows a preview before importing, progress while importing, and the last 10 imports.

Rows are sent to the database 500 at a time; one call accepts at most 1000.

## Database

- Schema `xref` (not reachable from the browser): `brands`, `parts` (one row per SKU), `part_numbers`
  (SKU / OE / cross numbers, original and normalised), `imports`.
- Functions: `xref_search(query, limit)`, `xref_get_part(sku)`, `xref_summary()` (Sales Desk users),
  `xref_import(rows, file_name, import_id, finished)` (active administrators).
- Tests: `supabase/tests/xref_cross_reference.test.sql`, `frontend/tests/crossReference.test.mjs`.
- Checked with 150,000 parts and 1.8 million numbers: searches return in under 60 ms; a 1000-row import call takes about a second.

## Later
- Part photos.
- Stock levels and price in the results once the ERP is connected.
