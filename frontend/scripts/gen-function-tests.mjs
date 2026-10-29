// Generates supabase/tests/bi_functions.test.sql: every Reporting function, parsed by the real
// frontend parser and run through public.bi_query against a small fixed table.
// Run from frontend/:  node --experimental-strip-types scripts/gen-function-tests.mjs
import {writeFileSync} from 'node:fs'
import {parseExpression} from '../src/biExpression.ts'

// Test rows (table fn_lines):
// id | branch    | code   | qty | price  | d          | note
//  1 | Centurion | IT0001 |  2  | 100.00 | 2026-10-26 | '  brake pads  '
//  2 | Pretoria  | IT0002 |  5  |  50.50 | 2026-10-27 | null
//  3 | Centurion | IT0003 |  1  |  10.00 | 2026-03-15 | 'GRV-2026-0042'
const ONE='id = 1', TWO='id = 2', THREE='id = 3'

// m: measure (aggregate over all rows unless cond); d: dimension value (distinct rows); expect: rows
export const CASES=[
  // aggregation
  {m:'Sum(qty * price)',expect:[[462.5]]},
  {m:'Sum(DISTINCT qty)',expect:[[8]]},
  {m:"Sum(If(branch = 'Centurion', qty))",expect:[[3]]},
  {m:'Count(*)',expect:[[3]]},{m:'Count(note)',expect:[[2]]},{m:'Count(DISTINCT branch)',expect:[[2]]},
  {m:'Avg(price)',expect:[[53.5]]},{m:'Round(Avg(DISTINCT qty), 4)',expect:[[2.6667]]},
  {m:'Min(d)',expect:[['2026-03-15']]},{m:'Max(qty)',expect:[[5]]},
  {m:'Median(qty)',expect:[[2]]},{m:'Round(StDev(qty), 4)',expect:[[2.0817]]},
  {m:"Concat(DISTINCT branch, ', ')",expect:[['Centurion, Pretoria']]},{m:'Concat(code)',expect:[['IT0001IT0002IT0003']]},
  {m:'MinString(code)',expect:[['IT0001']]},{m:'MaxString(branch)',expect:[['Pretoria']]},
  {m:'Only(branch)',expect:[[null]]},{m:'Only(branch)',cond:ONE,expect:[['Centurion']]},
  // text
  {d:"Upper('brake pads')",expect:[['BRAKE PADS']]},{d:"Lower('IT0001')",expect:[['it0001']]},
  {d:"Capitalize('east rand')",expect:[['East Rand']]},{d:'Trim(note)',cond:ONE,expect:[['brake pads']]},
  {d:'LTrim(note)',cond:ONE,expect:[['brake pads  ']]},{d:'RTrim(note)',cond:ONE,expect:[['  brake pads']]},
  {d:'Len(code)',cond:ONE,expect:[[6]]},{d:'Left(code, 2)',cond:ONE,expect:[['IT']]},{d:'Right(code, 4)',cond:ONE,expect:[['0001']]},
  {d:'Mid(code, 3)',cond:ONE,expect:[['0001']]},{d:'Mid(code, 3, 2)',cond:ONE,expect:[['00']]},
  {d:"Index('Brake pads', 'pad')",expect:[[7]]},{d:"Index('Brake pads', 'x')",expect:[[0]]},
  {d:"Replace(branch, 'Pre', 'X')",cond:TWO,expect:[['Xtoria']]},
  {d:"SubField(note, '-', 2)",cond:THREE,expect:[['2026']]},{d:"SubField(note, '-', 9)",cond:THREE,expect:[[null]]},
  {d:"Repeat('*', 3)",expect:[['***']]},{d:"Text(qty) & ' units'",cond:TWO,expect:[['5 units']]},
  {d:"branch & ' - ' & code",cond:TWO,expect:[['Pretoria - IT0002']]},{d:"note & '!'",cond:TWO,expect:[['!']]},
  // number
  {d:'Round(1234.567, 2)',expect:[[1234.57]]},{d:'Round(2.5)',expect:[[3]]},{d:'Floor(7.9)',expect:[[7]]},{d:'Ceil(7.1)',expect:[[8]]},
  {d:'Abs(-12)',expect:[[12]]},{d:'Sign(-12)',expect:[[-1]]},{d:'Mod(17, 5)',expect:[[2]]},{d:'Mod(17, 0)',expect:[[null]]},
  {d:'Div(17, 5)',expect:[[3]]},{d:'Div(17, 0)',expect:[[null]]},{d:'Sqrt(81)',expect:[[9]]},{d:'Sqrt(-1)',expect:[[null]]},
  {d:'Pow(1.15, 2)',expect:[[1.3225]]},{d:'Round(Exp(1), 4)',expect:[[2.7183]]},{d:'Round(Log(10), 4)',expect:[[2.3026]]},
  {d:'Log(0)',expect:[[null]]},{d:'Log10(1000)',expect:[[3]]},
  {d:'RangeSum(qty, null, 2)',cond:ONE,expect:[[4]]},{d:'qty + null',cond:ONE,expect:[[null]]},
  {d:'RangeMax(0, qty - 5)',cond:ONE,expect:[[0]]},{d:'RangeMin(qty, 3)',cond:TWO,expect:[[3]]},
  {d:"Num('12.50') * 2",expect:[[25]]},{d:'qty / 0',cond:ONE,expect:[[null]]},
  // date
  {d:'DaysBetween(AddDays(Today(), -7), Today())',expect:[[7]]},{d:'Year(Now()) = Year(Today())',expect:[[true]]},
  {d:"Date('2026-10-28')",expect:[['2026-10-28']]},{d:'Year(d)',cond:ONE,expect:[[2026]]},{d:'Quarter(d)',cond:THREE,expect:[[1]]},
  {d:'Month(d)',cond:ONE,expect:[[10]]},{d:'Week(d)',cond:ONE,expect:[[44]]},{d:'Day(d)',cond:ONE,expect:[[26]]},
  {d:'WeekDay(d)',cond:ONE,expect:[[1]]},{d:'MonthName(d)',cond:ONE,expect:[['Oct 2026']]},{d:'YearMonth(d)',cond:THREE,expect:[['2026-03']]},
  {d:'WeekStart(d)',cond:TWO,expect:[['2026-10-26']]},{d:'MonthStart(d)',cond:TWO,expect:[['2026-10-01']]},
  {d:'MonthEnd(d)',cond:THREE,expect:[['2026-03-31']]},{d:'QuarterStart(d)',cond:ONE,expect:[['2026-10-01']]},
  {d:'YearStart(d)',cond:ONE,expect:[['2026-01-01']]},{d:'YearEnd(d)',cond:ONE,expect:[['2026-12-31']]},
  {d:'AddDays(d, -26)',cond:ONE,expect:[['2026-09-30']]},{d:'AddMonths(d, 1)',cond:THREE,expect:[['2026-04-15']]},
  {d:"AddMonths(Date('2026-01-31'), 1)",expect:[['2026-02-28']]},{d:'AddYears(d, -1)',cond:ONE,expect:[['2025-10-26']]},
  {d:'DaysBetween(d, Date(\'2026-10-31\'))',cond:ONE,expect:[[5]]},
  {m:'Count(*)',cond:"d >= MonthStart(Date('2026-10-28'))",expect:[[2]]},
  // logic
  {d:"If(qty >= 5, 'Bulk', 'Single')",cond:TWO,expect:[['Bulk']]},{d:'If(qty >= 5, 1)',cond:ONE,expect:[[null]]},
  {d:"Alt(note, code, 'none')",cond:TWO,expect:[['IT0002']]},{d:'Coalesce(note, code)',cond:TWO,expect:[['IT0002']]},
  {d:'IsNull(note)',cond:TWO,expect:[[true]]},{d:'If(qty > 2, qty, Null())',cond:ONE,expect:[[null]]},
  {d:"Pick(2, 'a', 'b', 'c')",expect:[['b']]},{d:"Pick(9, 'a', 'b')",expect:[[null]]},{d:"Pick(Quarter(d), 'Q1', 'Q2', 'Q3', 'Q4')",cond:THREE,expect:[['Q1']]},
  {d:"Match(branch, 'Pretoria', 'Centurion')",cond:ONE,expect:[[2]]},{d:"Match(branch, 'centurion')",cond:ONE,expect:[[0]]},
  {d:"MixMatch(branch, 'centurion')",cond:ONE,expect:[[1]]},
  {d:"WildMatch(note, '*brake*', 'grv*')",cond:THREE,expect:[[2]]},{d:"WildMatch(code, 'IT000?')",cond:ONE,expect:[[1]]},
  {d:"WildMatch('100%', '1_0%')",expect:[[0]]},{d:"WildMatch('1_0%', '1_0%')",expect:[[1]]},
  {m:'Count(*)',cond:"WildMatch(branch, 'cent*') > 0",expect:[[2]]},
  // colours
  {d:'RGB(227, 73, 72)',cond:ONE,expect:[['rgb(227,73,72)']]},{d:'RGB(300, -5, 12.6)',cond:ONE,expect:[['rgb(255,0,13)']]},
  {d:"ColorMix1(0.5, '#ffffff', '#2a78d6')",cond:ONE,expect:[['rgb(149,188,235)']]},{d:"ColorMix1(2, '#000000', '#FFFFFF')",cond:ONE,expect:[['rgb(255,255,255)']]},
  {d:"ColorMix1(0.5, 'red', '#ffffff')",cond:ONE,expect:[[null]]},
  {d:"not IsNull(note) and qty < 3",cond:ONE,expect:[[true]]},
  {d:'1 + 2 * 3 // comment', expect:[[7]]},
]

const sql=s=>s.replace(/'/g,"''")
const lines=[`-- GENERATED by frontend/scripts/gen-function-tests.mjs from the cases in that file. Do not edit by hand.
-- Every Reporting function, parsed by the frontend parser and run through public.bi_query.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','52000000-0000-0000-0000-000000000001','authenticated','authenticated','fn-builder@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values ('52000000-0000-0000-0000-000000000001','report_builder');

create table bi_data.fn_lines(id bigint, branch text, code text, qty bigint, price numeric, d date, note text);
insert into bi_data.fn_lines values
 (1,'Centurion','IT0001',2,100.00,'2026-10-26','  brake pads  '),
 (2,'Pretoria','IT0002',5,50.50,'2026-10-27',null),
 (3,'Centurion','IT0003',1,10.00,'2026-03-15','GRV-2026-0042');
insert into bi.data_tables(table_name,columns,row_count,last_loaded_at) values ('fn_lines',
 '[{"name":"id","type":"bigint"},{"name":"branch","type":"text"},{"name":"code","type":"text"},{"name":"qty","type":"bigint"},{"name":"price","type":"numeric"},{"name":"d","type":"date"},{"name":"note","type":"text"}]',3,now());

set local role authenticated;
set local request.jwt.claims='{"sub":"52000000-0000-0000-0000-000000000001","role":"authenticated"}';
select set_config('fn_test.app', public.bi_save_app('{"name":"Function tests","model":[{"alias":"lines","table_name":"fn_lines"}]}'::jsonb)::text, true) is not null as app_created;
`]
for(const c of CASES){
  const text=c.m||c.d
  const node=parseExpression(text)
  const spec={dimensions:c.d?[{expr:node}]:[],measures:c.m?[{expr:node}]:[],conditions:c.cond?[parseExpression(c.cond)]:[],limit:10}
  lines.push(`select is(public.bi_query(current_setting('fn_test.app')::uuid, '${sql(JSON.stringify(spec))}')->'rows', '${sql(JSON.stringify(c.expect))}'::jsonb, '${sql(text+(c.cond?`  [where ${c.cond}]`:''))}');`)
}
// errors the database must raise even if a browser skipped the parser's checks
const bad=[
  ['{"dimensions":[{"expr":{"t":"fn","name":"replace","args":[{"t":"str","v":"a"}]}}]}','22023','wrong argument count is rejected by the database'],
  ['{"dimensions":[{"expr":{"t":"fn","name":"max","distinct":true,"args":[{"t":"num","v":1}]}}]}','22023','DISTINCT is only accepted where allowed'],
  ['{"dimensions":[{"expr":{"t":"fn","name":"pg_read_file","args":[{"t":"str","v":"/etc/passwd"}]}}]}','22023','functions outside the catalogue are rejected'],
  ['{"dimensions":[{"expr":{"t":"fn","name":"concat","args":[{"t":"field","name":"code"}]}}]}','22023','aggregations are rejected in dimensions'],
  ['{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"fn","name":"only","args":[{"t":"field","name":"qty"}]}]}}]}','22023','nested aggregations are rejected'],
]
for(const [spec,code,desc] of bad)lines.push(`select throws_ok($q$select public.bi_query(current_setting('fn_test.app')::uuid, '${spec}')$q$, '${code}', null, '${desc}');`)
lines.push(`select is(public.bi_query(current_setting('fn_test.app')::uuid, '${sql(JSON.stringify({dimensions:[{expr:parseExpression("WildMatch(code, '%')")}],limit:5}))}')->'rows', '[[0]]'::jsonb, 'a % in a WildMatch pattern is literal, not a wildcard');`)
lines.push('reset role;','','select * from finish();','rollback;','')
const out=new URL('../../supabase/tests/bi_functions.test.sql',import.meta.url)
writeFileSync(out,lines.join('\n'))
console.log(`Wrote ${CASES.length+bad.length+1} checks to supabase/tests/bi_functions.test.sql`)
