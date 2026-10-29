// The Reporting function catalogue: the single list of functions that expressions may use.
// It drives the parser's checks, the suggestions in the expression editor, the in-app
// Function reference page and docs/REPORTING_FUNCTIONS.md. The database whitelist in
// bi.compile_expr (latest definition: migration 0066_bi_linked_tables.sql) implements the same list;
// supabase/tests/bi_functions.test.sql runs every function against real data.

export type FunctionCategory='Aggregation'|'Text'|'Number'|'Date'|'Logic'|'Color'
export type FunctionSpec={
  name:string                 // display name, e.g. "SubField"
  category:FunctionCategory
  args:[number,number]        // minimum and maximum argument count (Infinity = any number)
  signature:string
  description:string
  examples:{expr:string;result:string}[]
  aggregate?:boolean
  distinct?:boolean           // accepts DISTINCT, e.g. Count(DISTINCT x)
  aliases?:string[]
}

const ANY=Infinity

export const FUNCTION_CATALOGUE:FunctionSpec[]=[
  // ---------------------------------------------------------------- Aggregation
  {name:'Sum',category:'Aggregation',aggregate:true,distinct:true,args:[1,1],signature:'Sum([DISTINCT] expression)',
    description:'Adds up the expression over all rows in the current selection (per chart dimension value).',
    examples:[{expr:'Sum(qty * unit_price)',result:'Sales value'},{expr:"Sum(If(branch = 'Centurion', qty))",result:'Units sold in Centurion only'}]},
  {name:'Count',category:'Aggregation',aggregate:true,distinct:true,args:[1,1],signature:'Count([DISTINCT] expression) or Count(*)',
    description:'Counts rows where the expression is not empty. Count(*) counts all rows; Count(DISTINCT x) counts different values.',
    examples:[{expr:'Count(*)',result:'Number of lines'},{expr:'Count(DISTINCT invoice_no)',result:'Number of invoices'}]},
  {name:'Avg',category:'Aggregation',aggregate:true,distinct:true,args:[1,1],signature:'Avg([DISTINCT] expression)',
    description:'Average of the expression, ignoring empty values.',examples:[{expr:'Avg(unit_price)',result:'Average selling price'}]},
  {name:'Min',category:'Aggregation',aggregate:true,args:[1,1],signature:'Min(expression)',
    description:'Smallest value (numbers or dates).',examples:[{expr:'Min(invoice_date)',result:'First invoice date'}]},
  {name:'Max',category:'Aggregation',aggregate:true,args:[1,1],signature:'Max(expression)',
    description:'Largest value (numbers or dates).',examples:[{expr:'Max(invoice_date)',result:'Last invoice date'}]},
  {name:'Median',category:'Aggregation',aggregate:true,args:[1,1],signature:'Median(expression)',
    description:'Middle value of a number expression.',examples:[{expr:'Median(qty)',result:'Typical quantity per line'}]},
  {name:'StDev',category:'Aggregation',aggregate:true,args:[1,1],signature:'StDev(expression)',
    description:'Sample standard deviation of a number expression.',examples:[{expr:'StDev(qty)',result:'Spread of quantities'}]},
  {name:'Concat',category:'Aggregation',aggregate:true,distinct:true,args:[1,2],signature:"Concat([DISTINCT] text [, delimiter])",
    description:'Joins the text of all rows into one string, sorted, with an optional delimiter (default none).',
    examples:[{expr:"Concat(DISTINCT branch, ', ')",result:"'Centurion, East Rand, Midrand, Pretoria'"}]},
  {name:'MinString',category:'Aggregation',aggregate:true,args:[1,1],signature:'MinString(text)',
    description:'First text value in alphabetical order.',examples:[{expr:'MinString(description)',result:"'Air filter 102'"}]},
  {name:'MaxString',category:'Aggregation',aggregate:true,args:[1,1],signature:'MaxString(text)',
    description:'Last text value in alphabetical order.',examples:[{expr:'MaxString(branch)',result:"'Pretoria'"}]},
  {name:'Only',category:'Aggregation',aggregate:true,args:[1,1],signature:'Only(expression)',
    description:'The value if every row has the same one, otherwise empty. Useful in KPIs that should show one item.',
    examples:[{expr:'Only(branch)',result:"'Centurion' when only Centurion is selected"}]},

  // ---------------------------------------------------------------- Text
  {name:'Upper',category:'Text',args:[1,1],signature:'Upper(text)',description:'Text in capitals.',examples:[{expr:"Upper('brake pads')",result:"'BRAKE PADS'"}]},
  {name:'Lower',category:'Text',args:[1,1],signature:'Lower(text)',description:'Text in lower case.',examples:[{expr:"Lower('IT0001')",result:"'it0001'"}]},
  {name:'Capitalize',category:'Text',args:[1,1],signature:'Capitalize(text)',description:'First letter of every word in capitals.',examples:[{expr:"Capitalize('east rand')",result:"'East Rand'"}]},
  {name:'Trim',category:'Text',args:[1,1],signature:'Trim(text)',description:'Removes spaces at the start and end.',examples:[{expr:"Trim('  BRK  ')",result:"'BRK'"}]},
  {name:'LTrim',category:'Text',args:[1,1],signature:'LTrim(text)',description:'Removes spaces at the start.',examples:[{expr:"LTrim('  BRK')",result:"'BRK'"}]},
  {name:'RTrim',category:'Text',args:[1,1],signature:'RTrim(text)',description:'Removes spaces at the end.',examples:[{expr:"RTrim('BRK  ')",result:"'BRK'"}]},
  {name:'Len',category:'Text',args:[1,1],signature:'Len(text)',description:'Number of characters.',examples:[{expr:"Len('IT0001')",result:'6'}]},
  {name:'Left',category:'Text',args:[2,2],signature:'Left(text, count)',description:'The first characters of the text.',examples:[{expr:'Left(item_code, 2)',result:"'IT'"}]},
  {name:'Right',category:'Text',args:[2,2],signature:'Right(text, count)',description:'The last characters of the text.',examples:[{expr:"Right('IT0001', 4)",result:"'0001'"}]},
  {name:'Mid',category:'Text',args:[2,3],signature:'Mid(text, start [, count])',description:'Part of the text from a position (the first character is 1), optionally limited to a number of characters.',
    examples:[{expr:"Mid('IT0001', 3)",result:"'0001'"},{expr:"Mid('IT0001', 3, 2)",result:"'00'"}]},
  {name:'Index',category:'Text',args:[2,2],signature:'Index(text, search)',description:'Position of the first occurrence of search in text (1-based), or 0 if not found.',examples:[{expr:"Index('Brake pads', 'pad')",result:'7'}]},
  {name:'Replace',category:'Text',args:[3,3],signature:'Replace(text, from, to)',description:'Replaces every occurrence of from with to.',examples:[{expr:"Replace('East Rand', ' ', '_')",result:"'East_Rand'"}]},
  {name:'SubField',category:'Text',args:[3,3],signature:'SubField(text, delimiter, n)',description:'The n-th part of the text split on the delimiter.',examples:[{expr:"SubField('GRV-2026-0042', '-', 2)",result:"'2026'"}]},
  {name:'Repeat',category:'Text',args:[2,2],signature:'Repeat(text, count)',description:'The text repeated a number of times.',examples:[{expr:"Repeat('*', 3)",result:"'***'"}]},
  {name:'Text',category:'Text',args:[1,1],signature:'Text(value)',description:'Turns any value into text.',examples:[{expr:"Text(2026) & '-Q4'",result:"'2026-Q4'"}]},

  // ---------------------------------------------------------------- Number
  {name:'Round',category:'Number',args:[1,2],signature:'Round(number [, decimals])',description:'Rounds to a number of decimals (default 0).',examples:[{expr:'Round(1234.567, 2)',result:'1234.57'}]},
  {name:'Floor',category:'Number',args:[1,1],signature:'Floor(number)',description:'Rounds down to a whole number.',examples:[{expr:'Floor(7.9)',result:'7'}]},
  {name:'Ceil',category:'Number',args:[1,1],signature:'Ceil(number)',description:'Rounds up to a whole number.',examples:[{expr:'Ceil(7.1)',result:'8'}]},
  {name:'Abs',category:'Number',args:[1,1],signature:'Abs(number)',description:'The number without its sign.',examples:[{expr:'Abs(-12)',result:'12'}]},
  {name:'Sign',category:'Number',args:[1,1],signature:'Sign(number)',description:'1 for positive, -1 for negative, 0 for zero.',examples:[{expr:'Sign(-12)',result:'-1'}]},
  {name:'Mod',category:'Number',args:[2,2],signature:'Mod(number, divisor)',description:'Remainder after dividing (empty when the divisor is 0).',examples:[{expr:'Mod(17, 5)',result:'2'}]},
  {name:'Div',category:'Number',args:[2,2],signature:'Div(number, divisor)',description:'Whole-number division without the remainder (empty when the divisor is 0).',examples:[{expr:'Div(17, 5)',result:'3'}]},
  {name:'Sqrt',category:'Number',args:[1,1],signature:'Sqrt(number)',description:'Square root (empty for negative numbers).',examples:[{expr:'Sqrt(81)',result:'9'}]},
  {name:'Pow',category:'Number',args:[2,2],signature:'Pow(number, exponent)',description:'The number raised to a power.',examples:[{expr:'Pow(1.15, 2)',result:'1.3225'}]},
  {name:'Exp',category:'Number',args:[1,1],signature:'Exp(number)',description:'e raised to the number.',examples:[{expr:'Round(Exp(1), 4)',result:'2.7183'}]},
  {name:'Log',category:'Number',args:[1,1],signature:'Log(number)',description:'Natural logarithm (empty for 0 or less).',examples:[{expr:'Round(Log(10), 4)',result:'2.3026'}]},
  {name:'Log10',category:'Number',args:[1,1],signature:'Log10(number)',description:'Base-10 logarithm (empty for 0 or less).',examples:[{expr:'Log10(1000)',result:'3'}]},
  {name:'RangeSum',category:'Number',args:[2,ANY],signature:'RangeSum(value1, value2, …)',description:'Adds values, treating empty ones as 0 (unlike +, where one empty value makes the result empty).',examples:[{expr:'RangeSum(qty, null, 2)',result:'qty + 2'}]},
  {name:'RangeMax',category:'Number',args:[2,ANY],signature:'RangeMax(value1, value2, …)',description:'Largest of the values, ignoring empty ones.',examples:[{expr:'RangeMax(0, qty - 5)',result:'qty - 5, but never below 0'}]},
  {name:'RangeMin',category:'Number',args:[2,ANY],signature:'RangeMin(value1, value2, …)',description:'Smallest of the values, ignoring empty ones.',examples:[{expr:'RangeMin(qty, 3)',result:'qty, capped at 3'}]},
  {name:'Num',category:'Number',args:[1,1],signature:'Num(value)',description:'Turns text that contains a number into a number.',examples:[{expr:"Num('12.50') * 2",result:'25'}]},

  // ---------------------------------------------------------------- Date
  {name:'Today',category:'Date',args:[0,0],signature:'Today()',description:"Today's date.",examples:[{expr:'invoice_date = Today() - 1',result:'Rows from yesterday'}]},
  {name:'Now',category:'Date',args:[0,0],signature:'Now()',description:'The current date and time.',examples:[{expr:'Now()',result:'2026-10-28 19:45'}]},
  {name:'Date',category:'Date',args:[1,1],signature:'Date(value)',description:'The date part of a timestamp, or text such as \'2026-10-28\' turned into a date.',examples:[{expr:"Date('2026-10-28')",result:'2026-10-28'}]},
  {name:'Year',category:'Date',args:[1,1],signature:'Year(date)',description:'The year as a number.',examples:[{expr:'Year(invoice_date)',result:'2026'}]},
  {name:'Quarter',category:'Date',args:[1,1],signature:'Quarter(date)',description:'The quarter, 1 to 4.',examples:[{expr:'Quarter(invoice_date)',result:'4'}]},
  {name:'Month',category:'Date',args:[1,1],signature:'Month(date)',description:'The month as a number, 1 to 12.',examples:[{expr:'Month(invoice_date)',result:'10'}]},
  {name:'Week',category:'Date',args:[1,1],signature:'Week(date)',description:'The ISO week number, 1 to 53.',examples:[{expr:'Week(invoice_date)',result:'44'}]},
  {name:'Day',category:'Date',args:[1,1],signature:'Day(date)',description:'The day of the month, 1 to 31.',examples:[{expr:'Day(invoice_date)',result:'28'}]},
  {name:'WeekDay',category:'Date',args:[1,1],signature:'WeekDay(date)',description:'Day of the week as a number: 1 = Monday … 7 = Sunday.',examples:[{expr:'WeekDay(invoice_date) <= 5',result:'Weekdays only'}]},
  {name:'MonthName',category:'Date',args:[1,1],signature:'MonthName(date)',description:"Month and year as text, e.g. 'Oct 2026'. Sorts alphabetically; use YearMonth for date order.",examples:[{expr:'MonthName(invoice_date)',result:"'Oct 2026'"}]},
  {name:'YearMonth',category:'Date',args:[1,1],signature:'YearMonth(date)',description:"Year and month as text that sorts in date order, e.g. '2026-10'.",examples:[{expr:'YearMonth(invoice_date)',result:"'2026-10'"}]},
  {name:'WeekStart',category:'Date',args:[1,1],signature:'WeekStart(date)',description:'The Monday of the week.',examples:[{expr:'WeekStart(invoice_date)',result:'2026-10-26'}]},
  {name:'MonthStart',category:'Date',args:[1,1],signature:'MonthStart(date)',description:'The first day of the month.',examples:[{expr:'invoice_date >= MonthStart(Today())',result:'Month to date'}]},
  {name:'MonthEnd',category:'Date',args:[1,1],signature:'MonthEnd(date)',description:'The last day of the month.',examples:[{expr:'MonthEnd(Today())',result:'2026-10-31'}]},
  {name:'QuarterStart',category:'Date',args:[1,1],signature:'QuarterStart(date)',description:'The first day of the quarter.',examples:[{expr:'QuarterStart(Today())',result:'2026-10-01'}]},
  {name:'YearStart',category:'Date',args:[1,1],signature:'YearStart(date)',description:'The first day of the year.',examples:[{expr:'invoice_date >= YearStart(Today())',result:'Year to date'}]},
  {name:'YearEnd',category:'Date',args:[1,1],signature:'YearEnd(date)',description:'The last day of the year.',examples:[{expr:'YearEnd(Today())',result:'2026-12-31'}]},
  {name:'AddDays',category:'Date',args:[2,2],signature:'AddDays(date, days)',description:'The date moved by a number of days (negative goes back).',examples:[{expr:'AddDays(Today(), -7)',result:'A week ago'}]},
  {name:'AddMonths',category:'Date',args:[2,2],signature:'AddMonths(date, months)',description:'The date moved by a number of months.',examples:[{expr:'invoice_date >= AddMonths(MonthStart(Today()), -1)',result:'Since the start of last month'}]},
  {name:'AddYears',category:'Date',args:[2,2],signature:'AddYears(date, years)',description:'The date moved by a number of years.',examples:[{expr:'AddYears(Today(), -1)',result:'Same day last year'}]},
  {name:'DaysBetween',category:'Date',args:[2,2],signature:'DaysBetween(from, to)',description:'Number of days from the first date to the second.',examples:[{expr:'DaysBetween(invoice_date, Today())',result:'Age of the invoice in days'}]},

  // ---------------------------------------------------------------- Logic
  {name:'If',category:'Logic',args:[2,3],signature:'If(condition, then [, else])',description:'The then-value when the condition is true, otherwise the else-value (empty when left out). Inside an aggregation it works like a filter: Sum(If(…, x)).',
    examples:[{expr:"If(qty >= 5, 'Bulk', 'Single')",result:"'Bulk' or 'Single'"},{expr:'Sum(If(invoice_date = Today() - 1, qty * unit_price))',result:'Sales yesterday, in a chart with no condition'}]},
  {name:'Alt',category:'Logic',args:[2,ANY],aliases:['Coalesce'],signature:'Alt(value1, value2, …)',description:'The first value that is not empty.',examples:[{expr:"Alt(description, item_code, 'Unknown')",result:'Description, or the code when there is none'}]},
  {name:'IsNull',category:'Logic',args:[1,1],signature:'IsNull(value)',description:'True when the value is empty.',examples:[{expr:'IsNull(cost_price)',result:'Items without a cost price'}]},
  {name:'Null',category:'Logic',args:[0,0],signature:'Null()',description:'An empty value.',examples:[{expr:'If(qty > 0, qty, Null())',result:'Leaves out zero and negative quantities'}]},
  {name:'Pick',category:'Logic',args:[2,ANY],signature:'Pick(n, value1, value2, …)',description:'The n-th value from the list (empty when n is out of range).',examples:[{expr:"Pick(Quarter(invoice_date), 'Q1', 'Q2', 'Q3', 'Q4')",result:"'Q4'"}]},
  {name:'Match',category:'Logic',args:[2,ANY],signature:'Match(value, option1, option2, …)',description:'Position (1, 2, …) of the first option equal to the value, or 0. Case-sensitive. Use > 0 as a condition.',
    examples:[{expr:"Match(branch, 'Centurion', 'Pretoria') > 0",result:'Only Centurion and Pretoria'}]},
  {name:'MixMatch',category:'Logic',args:[2,ANY],signature:'MixMatch(value, option1, option2, …)',description:'Like Match, but ignores upper and lower case.',examples:[{expr:"MixMatch(branch, 'centurion') > 0",result:'Centurion, whatever the case'}]},
  {name:'WildMatch',category:'Logic',args:[2,ANY],signature:'WildMatch(value, pattern1, pattern2, …)',description:'Like MixMatch, with * for any characters and ? for one character.',
    examples:[{expr:"WildMatch(description, 'brake*', '*filter*') > 0",result:'Brakes and filters'}]},
  // colours, for table cell background and text colour expressions
  {name:'RGB',category:'Color',args:[3,3],signature:'RGB(red, green, blue)',description:'A colour from red, green and blue amounts (0 to 255). Colour expressions can also return a name such as \'red\' or a code such as \'#e34948\'.',
    examples:[{expr:'RGB(227, 73, 72)',result:"'rgb(227,73,72)' (red)"},{expr:"If(Sum(qty) < 10, RGB(251, 227, 221))",result:'Light red when fewer than 10 sold'}]},
  {name:'ColorMix1',category:'Color',args:[3,3],signature:"ColorMix1(value, '#colour0', '#colour1')",description:'Blends two colours (written as #rrggbb): value 0 gives the first colour, 1 the second, in between a mix. Values outside 0 to 1 are clamped.',
    examples:[{expr:"ColorMix1(0.5, '#ffffff', '#2a78d6')",result:"'rgb(149,188,235)' (light blue)"},{expr:"ColorMix1(Sum(qty) / 1000, '#ffffff', '#1baf7a')",result:'A heat-map shade per row'}]},
]

export const OPERATORS=[
  {op:'+  -  *  /',description:'Arithmetic. Dividing by 0 gives an empty value instead of an error.',example:'qty * unit_price'},
  {op:'&',description:'Joins text (concatenation). Empty values count as empty text.',example:"branch & ' - ' & item_code"},
  {op:'=  <>  <  <=  >  >=',description:'Comparisons (!= also works for <>).',example:"branch <> 'Pretoria'"},
  {op:'and  or  not',description:'Combine conditions.',example:"qty > 1 and not branch = 'Midrand'"},
  {op:'( )',description:'Group parts of an expression.',example:'(unit_price - cost_price) / unit_price'},
  {op:'[Name]',description:'A master measure, or a field whose name has spaces.',example:'[Sales] - [Cost]'},
  {op:"'text'",description:"Text values. Double a quote to include one: 'it''s'.",example:"'Centurion'"},
  {op:'// note  /* note */',description:'Comments, ignored when calculating. Useful in long expressions.',example:'Sum(qty) // units'},
]

const byName=new Map<string,FunctionSpec>()
for(const spec of FUNCTION_CATALOGUE){byName.set(spec.name.toLowerCase(),spec);for(const alias of spec.aliases||[])byName.set(alias.toLowerCase(),spec)}

export function findFunction(name:string){return byName.get(name.toLowerCase())}
export const AGGREGATION_NAMES=FUNCTION_CATALOGUE.filter(spec=>spec.aggregate).map(spec=>spec.name.toLowerCase())
export const CATEGORIES:FunctionCategory[]=['Aggregation','Text','Number','Date','Logic','Color']

// Simple relevance search over names, signatures and descriptions.
export function searchFunctions(query:string,specs:FunctionSpec[]=FUNCTION_CATALOGUE){
  const needle=query.trim().toLowerCase()
  if(!needle)return specs
  const words=needle.split(/\s+/)
  return specs.map(spec=>{
    const name=spec.name.toLowerCase();const text=`${spec.signature} ${spec.description} ${spec.category} ${(spec.aliases||[]).join(' ')}`.toLowerCase()
    let score=0
    if(name===needle)score+=100
    else if(name.startsWith(needle))score+=50
    else if(name.includes(needle))score+=25
    for(const word of words)if(text.includes(word))score+=5
    if(!words.every(word=>name.includes(word)||text.includes(word)))score=0
    return {spec,score}
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.spec.name.localeCompare(b.spec.name)).map(item=>item.spec)
}
