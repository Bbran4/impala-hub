# Reporting functions

<!-- GENERATED from frontend/src/biFunctions.ts by frontend/scripts/gen-function-docs.mjs. Do not edit by hand. -->

Expressions are used for dimensions, measures, master measures and conditions in Reporting apps.
The same list is in the app under **Reporting → Function reference**, and the expression editor suggests
these functions as you type.

- **Dimensions** split the data (`branch`, `YearMonth(invoice_date)`). They cannot aggregate.
- **Measures** calculate a value per dimension value and must aggregate (`Sum(qty * unit_price)`).
- **Conditions** filter rows before anything is calculated (`invoice_date = Today() - 1`).
- **Master measures** are reusable measures, used as `[Name]`.
- Function names are not case-sensitive. Field names follow the sync agent's naming: lower case with underscores;
  `[Cost Price]` and `cost_price` mean the same field. Use `table.field` when two tables have the same field name.
- Long expressions can be written over several lines with `//` and `/* */` comments, using the expand button
  next to every expression box.

## Contents

- [Aggregation](#aggregation): Sum, Count, Avg, Min, Max, Median, StDev, Concat, MinString, MaxString, Only
- [Text](#text): Upper, Lower, Capitalize, Trim, LTrim, RTrim, Len, Left, Right, Mid, Index, Replace, SubField, Repeat, Text
- [Number](#number): Round, Floor, Ceil, Abs, Sign, Mod, Div, Sqrt, Pow, Exp, Log, Log10, RangeSum, RangeMax, RangeMin, Num
- [Date](#date): Today, Now, Date, Year, Quarter, Month, Week, Day, WeekDay, MonthName, YearMonth, WeekStart, MonthStart, MonthEnd, QuarterStart, YearStart, YearEnd, AddDays, AddMonths, AddYears, DaysBetween
- [Logic](#logic): If, Alt, IsNull, Null, Pick, Match, MixMatch, WildMatch
- [Operators and syntax](#operators-and-syntax)

## Operators and syntax

| Operator | Meaning | Example |
|---|---|---|
| `+` `-` `*` `/` | Arithmetic. Dividing by 0 gives an empty value instead of an error. | `qty * unit_price` |
| `&` | Joins text (concatenation). Empty values count as empty text. | `branch & ' - ' & item_code` |
| `=` `<>` `<` `<=` `>` `>=` | Comparisons (!= also works for <>). | `branch <> 'Pretoria'` |
| `and` `or` `not` | Combine conditions. | `qty > 1 and not branch = 'Midrand'` |
| `( )` | Group parts of an expression. | `(unit_price - cost_price) / unit_price` |
| `[Name]` | A master measure, or a field whose name has spaces. | `[Sales] - [Cost]` |
| `'text'` | Text values. Double a quote to include one: 'it''s'. | `'Centurion'` |
| `// note` `/* note */` | Comments, ignored when calculating. Useful in long expressions. | `Sum(qty) // units` |

## Recipes

| Need | Expression |
|---|---|
| Sales value | `Sum(qty * unit_price)` |
| Gross margin % | `(Sum(qty * unit_price) - Sum(qty * cost_price)) / Sum(qty * unit_price)` |
| Sold yesterday (condition) | `invoice_date = Today() - 1` |
| Month to date (condition) | `invoice_date >= MonthStart(Today())` |
| Same month last year (condition) | `YearMonth(invoice_date) = YearMonth(AddYears(Today(), -1))` |
| Only some branches, inside a measure | `Sum(If(Match(branch, 'Centurion', 'Pretoria') > 0, qty * unit_price))` |
| Label for a dimension | `branch & ' (' & Left(item_code, 2) & ')'` |
| Quarter label | `'Q' & Quarter(invoice_date) & ' ' & Year(invoice_date)` |
| Days since last sale | `DaysBetween(Max(invoice_date), Today())` |
| Number of invoices | `Count(DISTINCT invoice_no)` |

## Aggregation

Combine many rows into one value. Measures must use at least one. They cannot be nested (no Sum(Avg(x))), but If() inside them works like a filter. Each aggregation counts every record of the tables it uses once, like Qlik: Sum(qty_on_hand) from the stock items table adds each item once, even when the item is on many invoice lines.

### Sum

`Sum([DISTINCT] expression)`

Adds up the expression over all rows in the current selection (per chart dimension value).

- `Sum(qty * unit_price)` → Sales value
- `Sum(If(branch = 'Centurion', qty))` → Units sold in Centurion only

### Count

`Count([DISTINCT] expression) or Count(*)`

Counts rows where the expression is not empty. Count(*) counts all rows; Count(DISTINCT x) counts different values.

- `Count(*)` → Number of lines
- `Count(DISTINCT invoice_no)` → Number of invoices

### Avg

`Avg([DISTINCT] expression)`

Average of the expression, ignoring empty values.

- `Avg(unit_price)` → Average selling price

### Min

`Min(expression)`

Smallest value (numbers or dates).

- `Min(invoice_date)` → First invoice date

### Max

`Max(expression)`

Largest value (numbers or dates).

- `Max(invoice_date)` → Last invoice date

### Median

`Median(expression)`

Middle value of a number expression.

- `Median(qty)` → Typical quantity per line

### StDev

`StDev(expression)`

Sample standard deviation of a number expression.

- `StDev(qty)` → Spread of quantities

### Concat

`Concat([DISTINCT] text [, delimiter])`

Joins the text of all rows into one string, sorted, with an optional delimiter (default none).

- `Concat(DISTINCT branch, ', ')` → 'Centurion, East Rand, Midrand, Pretoria'

### MinString

`MinString(text)`

First text value in alphabetical order.

- `MinString(description)` → 'Air filter 102'

### MaxString

`MaxString(text)`

Last text value in alphabetical order.

- `MaxString(branch)` → 'Pretoria'

### Only

`Only(expression)`

The value if every row has the same one, otherwise empty. Useful in KPIs that should show one item.

- `Only(branch)` → 'Centurion' when only Centurion is selected

## Text

Work on text. Join text with the & operator.

### Upper

`Upper(text)`

Text in capitals.

- `Upper('brake pads')` → 'BRAKE PADS'

### Lower

`Lower(text)`

Text in lower case.

- `Lower('IT0001')` → 'it0001'

### Capitalize

`Capitalize(text)`

First letter of every word in capitals.

- `Capitalize('east rand')` → 'East Rand'

### Trim

`Trim(text)`

Removes spaces at the start and end.

- `Trim('  BRK  ')` → 'BRK'

### LTrim

`LTrim(text)`

Removes spaces at the start.

- `LTrim('  BRK')` → 'BRK'

### RTrim

`RTrim(text)`

Removes spaces at the end.

- `RTrim('BRK  ')` → 'BRK'

### Len

`Len(text)`

Number of characters.

- `Len('IT0001')` → 6

### Left

`Left(text, count)`

The first characters of the text.

- `Left(item_code, 2)` → 'IT'

### Right

`Right(text, count)`

The last characters of the text.

- `Right('IT0001', 4)` → '0001'

### Mid

`Mid(text, start [, count])`

Part of the text from a position (the first character is 1), optionally limited to a number of characters.

- `Mid('IT0001', 3)` → '0001'
- `Mid('IT0001', 3, 2)` → '00'

### Index

`Index(text, search)`

Position of the first occurrence of search in text (1-based), or 0 if not found.

- `Index('Brake pads', 'pad')` → 7

### Replace

`Replace(text, from, to)`

Replaces every occurrence of from with to.

- `Replace('East Rand', ' ', '_')` → 'East_Rand'

### SubField

`SubField(text, delimiter, n)`

The n-th part of the text split on the delimiter.

- `SubField('GRV-2026-0042', '-', 2)` → '2026'

### Repeat

`Repeat(text, count)`

The text repeated a number of times.

- `Repeat('*', 3)` → '***'

### Text

`Text(value)`

Turns any value into text.

- `Text(2026) & '-Q4'` → '2026-Q4'

## Number

Work on numbers. Dividing by 0, Mod/Div by 0, Sqrt of a negative and Log of 0 give an empty value instead of an error.

### Round

`Round(number [, decimals])`

Rounds to a number of decimals (default 0).

- `Round(1234.567, 2)` → 1234.57

### Floor

`Floor(number)`

Rounds down to a whole number.

- `Floor(7.9)` → 7

### Ceil

`Ceil(number)`

Rounds up to a whole number.

- `Ceil(7.1)` → 8

### Abs

`Abs(number)`

The number without its sign.

- `Abs(-12)` → 12

### Sign

`Sign(number)`

1 for positive, -1 for negative, 0 for zero.

- `Sign(-12)` → -1

### Mod

`Mod(number, divisor)`

Remainder after dividing (empty when the divisor is 0).

- `Mod(17, 5)` → 2

### Div

`Div(number, divisor)`

Whole-number division without the remainder (empty when the divisor is 0).

- `Div(17, 5)` → 3

### Sqrt

`Sqrt(number)`

Square root (empty for negative numbers).

- `Sqrt(81)` → 9

### Pow

`Pow(number, exponent)`

The number raised to a power.

- `Pow(1.15, 2)` → 1.3225

### Exp

`Exp(number)`

e raised to the number.

- `Round(Exp(1), 4)` → 2.7183

### Log

`Log(number)`

Natural logarithm (empty for 0 or less).

- `Round(Log(10), 4)` → 2.3026

### Log10

`Log10(number)`

Base-10 logarithm (empty for 0 or less).

- `Log10(1000)` → 3

### RangeSum

`RangeSum(value1, value2, …)`

Adds values, treating empty ones as 0 (unlike +, where one empty value makes the result empty).

- `RangeSum(qty, null, 2)` → qty + 2

### RangeMax

`RangeMax(value1, value2, …)`

Largest of the values, ignoring empty ones.

- `RangeMax(0, qty - 5)` → qty - 5, but never below 0

### RangeMin

`RangeMin(value1, value2, …)`

Smallest of the values, ignoring empty ones.

- `RangeMin(qty, 3)` → qty, capped at 3

### Num

`Num(value)`

Turns text that contains a number into a number.

- `Num('12.50') * 2` → 25

## Date

Work on dates. Subtracting a number of days also works: Today() - 1.

### Today

`Today()`

Today's date.

- `invoice_date = Today() - 1` → Rows from yesterday

### Now

`Now()`

The current date and time.

- `Now()` → 2026-10-28 19:45

### Date

`Date(value)`

The date part of a timestamp, or text such as '2026-10-28' turned into a date.

- `Date('2026-10-28')` → 2026-10-28

### Year

`Year(date)`

The year as a number.

- `Year(invoice_date)` → 2026

### Quarter

`Quarter(date)`

The quarter, 1 to 4.

- `Quarter(invoice_date)` → 4

### Month

`Month(date)`

The month as a number, 1 to 12.

- `Month(invoice_date)` → 10

### Week

`Week(date)`

The ISO week number, 1 to 53.

- `Week(invoice_date)` → 44

### Day

`Day(date)`

The day of the month, 1 to 31.

- `Day(invoice_date)` → 28

### WeekDay

`WeekDay(date)`

Day of the week as a number: 1 = Monday … 7 = Sunday.

- `WeekDay(invoice_date) <= 5` → Weekdays only

### MonthName

`MonthName(date)`

Month and year as text, e.g. 'Oct 2026'. Sorts alphabetically; use YearMonth for date order.

- `MonthName(invoice_date)` → 'Oct 2026'

### YearMonth

`YearMonth(date)`

Year and month as text that sorts in date order, e.g. '2026-10'.

- `YearMonth(invoice_date)` → '2026-10'

### WeekStart

`WeekStart(date)`

The Monday of the week.

- `WeekStart(invoice_date)` → 2026-10-26

### MonthStart

`MonthStart(date)`

The first day of the month.

- `invoice_date >= MonthStart(Today())` → Month to date

### MonthEnd

`MonthEnd(date)`

The last day of the month.

- `MonthEnd(Today())` → 2026-10-31

### QuarterStart

`QuarterStart(date)`

The first day of the quarter.

- `QuarterStart(Today())` → 2026-10-01

### YearStart

`YearStart(date)`

The first day of the year.

- `invoice_date >= YearStart(Today())` → Year to date

### YearEnd

`YearEnd(date)`

The last day of the year.

- `YearEnd(Today())` → 2026-12-31

### AddDays

`AddDays(date, days)`

The date moved by a number of days (negative goes back).

- `AddDays(Today(), -7)` → A week ago

### AddMonths

`AddMonths(date, months)`

The date moved by a number of months.

- `invoice_date >= AddMonths(MonthStart(Today()), -1)` → Since the start of last month

### AddYears

`AddYears(date, years)`

The date moved by a number of years.

- `AddYears(Today(), -1)` → Same day last year

### DaysBetween

`DaysBetween(from, to)`

Number of days from the first date to the second.

- `DaysBetween(invoice_date, Today())` → Age of the invoice in days

## Logic

Conditions and choices. Comparisons give true or false, which can be used as conditions or with If().

### If

`If(condition, then [, else])`

The then-value when the condition is true, otherwise the else-value (empty when left out). Inside an aggregation it works like a filter: Sum(If(…, x)).

- `If(qty >= 5, 'Bulk', 'Single')` → 'Bulk' or 'Single'
- `Sum(If(invoice_date = Today() - 1, qty * unit_price))` → Sales yesterday, in a chart with no condition

### Alt

`Alt(value1, value2, …)` (also: Coalesce)

The first value that is not empty.

- `Alt(description, item_code, 'Unknown')` → Description, or the code when there is none

### IsNull

`IsNull(value)`

True when the value is empty.

- `IsNull(cost_price)` → Items without a cost price

### Null

`Null()`

An empty value.

- `If(qty > 0, qty, Null())` → Leaves out zero and negative quantities

### Pick

`Pick(n, value1, value2, …)`

The n-th value from the list (empty when n is out of range).

- `Pick(Quarter(invoice_date), 'Q1', 'Q2', 'Q3', 'Q4')` → 'Q4'

### Match

`Match(value, option1, option2, …)`

Position (1, 2, …) of the first option equal to the value, or 0. Case-sensitive. Use > 0 as a condition.

- `Match(branch, 'Centurion', 'Pretoria') > 0` → Only Centurion and Pretoria

### MixMatch

`MixMatch(value, option1, option2, …)`

Like Match, but ignores upper and lower case.

- `MixMatch(branch, 'centurion') > 0` → Centurion, whatever the case

### WildMatch

`WildMatch(value, pattern1, pattern2, …)`

Like MixMatch, with * for any characters and ? for one character.

- `WildMatch(description, 'brake*', '*filter*') > 0` → Brakes and filters
