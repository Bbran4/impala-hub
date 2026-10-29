// Generates docs/REPORTING_FUNCTIONS.md from the function catalogue (src/biFunctions.ts).
// Run from frontend/:  node --experimental-strip-types scripts/gen-function-docs.mjs
import {writeFileSync} from 'node:fs'
import {CATEGORIES,FUNCTION_CATALOGUE,OPERATORS} from '../src/biFunctions.ts'

const intro={
  Aggregation:'Combine many rows into one value. Measures must use at least one. They cannot be nested (no Sum(Avg(x))), but If() inside them works like a filter.',
  Text:'Work on text. Join text with the & operator.',
  Number:'Work on numbers. Dividing by 0, Mod/Div by 0, Sqrt of a negative and Log of 0 give an empty value instead of an error.',
  Date:'Work on dates. Subtracting a number of days also works: Today() - 1.',
  Logic:'Conditions and choices. Comparisons give true or false, which can be used as conditions or with If().',
}
const md=[`# Reporting functions

<!-- GENERATED from frontend/src/biFunctions.ts by frontend/scripts/gen-function-docs.mjs. Do not edit by hand. -->

Expressions are used for dimensions, measures, master measures and conditions in Reporting apps.
The same list is in the app under **Reporting → Function reference**, and the expression editor suggests
these functions as you type.

- **Dimensions** split the data (\`branch\`, \`YearMonth(invoice_date)\`). They cannot aggregate.
- **Measures** calculate a value per dimension value and must aggregate (\`Sum(qty * unit_price)\`).
- **Conditions** filter rows before anything is calculated (\`invoice_date = Today() - 1\`).
- **Master measures** are reusable measures, used as \`[Name]\`.
- Function names are not case-sensitive. Field names follow the sync agent's naming: lower case with underscores;
  \`[Cost Price]\` and \`cost_price\` mean the same field. Use \`table.field\` when two tables have the same field name.
- Long expressions can be written over several lines with \`//\` and \`/* */\` comments, using the expand button
  next to every expression box.

## Contents

${CATEGORIES.map(category=>`- [${category}](#${category.toLowerCase()}): ${FUNCTION_CATALOGUE.filter(spec=>spec.category===category).map(spec=>spec.name).join(', ')}`).join('\n')}
- [Operators and syntax](#operators-and-syntax)

## Operators and syntax

| Operator | Meaning | Example |
|---|---|---|
${OPERATORS.map(o=>`| \`${o.op.replace(/\s{2,}/g,'` `')}\` | ${o.description} | \`${o.example}\` |`).join('\n')}

## Recipes

| Need | Expression |
|---|---|
| Sales value | \`Sum(qty * unit_price)\` |
| Gross margin % | \`(Sum(qty * unit_price) - Sum(qty * cost_price)) / Sum(qty * unit_price)\` |
| Sold yesterday (condition) | \`invoice_date = Today() - 1\` |
| Month to date (condition) | \`invoice_date >= MonthStart(Today())\` |
| Same month last year (condition) | \`YearMonth(invoice_date) = YearMonth(AddYears(Today(), -1))\` |
| Only some branches, inside a measure | \`Sum(If(Match(branch, 'Centurion', 'Pretoria') > 0, qty * unit_price))\` |
| Label for a dimension | \`branch & ' (' & Left(item_code, 2) & ')'\` |
| Quarter label | \`'Q' & Quarter(invoice_date) & ' ' & Year(invoice_date)\` |
| Days since last sale | \`DaysBetween(Max(invoice_date), Today())\` |
| Number of invoices | \`Count(DISTINCT invoice_no)\` |
`]
for(const category of CATEGORIES){
  md.push(`## ${category}\n\n${intro[category]}\n`)
  for(const spec of FUNCTION_CATALOGUE.filter(item=>item.category===category)){
    md.push(`### ${spec.name}\n\n\`${spec.signature}\`${spec.aliases?.length?` (also: ${spec.aliases.join(', ')})`:''}\n\n${spec.description}\n\n${spec.examples.map(example=>`- \`${example.expr}\` → ${example.result}`).join('\n')}\n`)
  }
}
writeFileSync(new URL('../../docs/REPORTING_FUNCTIONS.md',import.meta.url),md.join('\n'))
console.log(`Wrote ${FUNCTION_CATALOGUE.length} functions to docs/REPORTING_FUNCTIONS.md`)
