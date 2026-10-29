begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Users: administrator, sales, management, stock-only, inactive sales
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000001','authenticated','authenticated','xref-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000002','authenticated','authenticated','xref-sales@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000003','authenticated','authenticated','xref-mgmt@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000004','authenticated','authenticated','xref-stock@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','92000000-0000-0000-0000-000000000005','authenticated','authenticated','xref-gone@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('92000000-0000-0000-0000-000000000001','administrator'),
('92000000-0000-0000-0000-000000000002','sales'),
('92000000-0000-0000-0000-000000000003','management'),
('92000000-0000-0000-0000-000000000004','stock'),
('92000000-0000-0000-0000-000000000005','sales');
update public.profiles set display_name='Xref Admin' where id='92000000-0000-0000-0000-000000000001';
update public.profiles set active=false where id='92000000-0000-0000-0000-000000000005';

-- Structure and direct access
select has_schema('xref','xref schema exists');
select ok(not has_schema_privilege('authenticated','xref','usage'),'signed-in users cannot reach the xref tables directly');
select ok(not has_schema_privilege('anon','xref','usage'),'signed-out users cannot reach the xref tables');
select ok(not has_function_privilege('anon','public.xref_search(text,integer)','execute'),'signed-out users cannot search');
select ok(not has_function_privilege('anon','public.xref_import(jsonb,text,uuid,boolean)','execute'),'signed-out users cannot import');
select is(xref.norm(' 14-451190/00. '),'1445119000','numbers ignore case, spaces, dashes, slashes and dots');
select is(xref.norm('lxs300'),'LXS300','numbers are upper case');
select is(xref.norm(' - '),null,'a number of only separators is empty');

-- Only administrators can import
set local role authenticated;
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.xref_import('[{"sku":"X1"}]'::jsonb,'f.xlsx')$$,'42501',null,'a salesperson cannot import');
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$select public.xref_import('[{"sku":"X1"}]'::jsonb,'f.xlsx')$$,'42501',null,'management cannot import');

-- The administrator imports the sample file (5 rows) plus rows that link to it, in two chunks
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000001","role":"authenticated"}';
create temp table imp_state(id uuid, first jsonb, second jsonb) on commit drop;
grant all on imp_state to authenticated;
insert into imp_state(first) select public.xref_import($$[
 {"row":2,"sku":"MH037WN5601","brand":"Mahle","brand_description":"Mahle is a reputable supplier.","title":"LINER KIT","description":"LINER KIT VOLVO D13","warranty":"1 year",
  "oe_numbers":["20760235","20858450"],"cross_numbers":["89886110","861612","14-451190-00"],
  "package_length_cm":16,"package_width_cm":16,"package_height_cm":31.8,"package_weight_kg":6.672,
  "specs":[{"label":"Cyl. Bore","value":"131 mm"},{"label":"Outer Diameter","value":"144mm"}]},
 {"row":3,"sku":"P040076","brand":"PAI","brand_description":"PAI is based in Atlanta.","title":"CONROD BOLT","description":"CONROD BOLT CUMMINS ISX","warranty":"2 years",
  "oe_numbers":["3678574"],"cross_numbers":[],"package_length_cm":"5,08","package_width_cm":5.08,"package_height_cm":15.24,"package_weight_kg":0.43,
  "specs":[{"label":"Thread size","value":"M12x1.25"}]},
 {"row":4,"sku":"FEB173607","brand":"Febi","title":"AIR FILTER KIT","description":"AIR FILTER KIT VOLVO FH VERSION 4","warranty":"3 years",
  "oe_numbers":["21834205S1","21115501S1"],"cross_numbers":["A-71420-S","LX3141","LXS300","LXS319","C331460/3"],
  "specs":[{"label":"Height","value":"383mm"},{"label":"Height","value":"415mm"}]}
]$$::jsonb,'Parts_info_002.xlsx');
update imp_state set id=(first->>'import_id')::uuid;
update imp_state set second=public.xref_import($$[
 {"row":5,"sku":"4962732X","brand":"ACV","title":"CYLINDER HEAD AFTERMARKET","description":"CYLINDER HEAD AFTERMARKET CUMMINS ISX","warranty":"1 year",
  "oe_numbers":["5413782","4962732","4331387"],"cross_numbers":[]},
 {"row":6,"sku":"VR02-10808-02","brand":"Victor-Reinz","title":"UPPER GASKET SET","description":"UPPER GASKET SET CUMMINS ISX","warranty":"1 year",
  "oe_numbers":["4352144","4955595","4025300"],"cross_numbers":["HS54775-1","131637","132057","4955595"]},
 {"row":7,"sku":"EL123456","brand":"Elring","title":"UPPER GASKET SET","description":"UPPER GASKET SET CUMMINS ISX","oe_numbers":["4025300"],"cross_numbers":[]},
 {"row":8,"sku":"FAR999","brand":"Far Away","description":"UNRELATED PART","oe_numbers":["132057"],"cross_numbers":["777"]},
 {"row":9,"sku":"FAR1000","brand":"Far Away","description":"TWO STEPS AWAY","oe_numbers":["777"]},
 {"row":10,"sku":"","brand":"Nobody"},
 {"row":11,"sku":"BADSIZE","package_weight_kg":"heavy"},
 {"row":12,"sku":"mh037wn5601","brand":"Mahle","title":"LINER KIT","description":"LINER KIT VOLVO D13 (UPDATED)","warranty":"1 year",
  "oe_numbers":["20760235","20858450"],"cross_numbers":["89886110","861612","14-451190-00"],
  "specs":[{"label":"Cyl. Bore","value":"131 mm"},{"label":"","value":""},{"label":"","value":"Wet liner"}]}
]$$::jsonb,'Parts_info_002.xlsx',(select id from imp_state),true);

select is((select (first->>'created')::int from imp_state),3,'first chunk creates 3 parts');
select is((select (second->>'created')::int from imp_state),5,'second chunk creates 5 parts');
select is((select (second->>'replaced')::int from imp_state),1,'a SKU already loaded (different case) is replaced, not duplicated');
select is((select jsonb_array_length(second->'skipped') from imp_state),2,'rows without a SKU or with a bad size are skipped');
select is((select second->'skipped'->0->>'reason' from imp_state),'No part number / SKU','the reason for a skipped row is given');
select is((select (second->'skipped'->1->>'row')::int from imp_state),11,'skipped rows report their file row');
select throws_ok($$select public.xref_import('[]'::jsonb,'x',(select id from imp_state))$$,'22023',null,'a finished import cannot be added to');
select throws_ok($$select public.xref_import(('['||repeat('{},',1000)||'{}]')::jsonb,'x')$$,'22023',null,'at most 1000 rows per call');

-- Search as a salesperson
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((public.xref_summary()->>'parts')::int,8,'summary counts the parts');
select is((public.xref_summary()->>'brands')::int,7,'summary counts brands that have parts');
select is(public.xref_summary()->>'can_import','false','salespeople do not get the import');
select is(jsonb_array_length(public.xref_summary()->'imports'),0,'salespeople do not see import history');

select is(public.xref_search('4955595')->'direct'->0->>'sku','VR02-10808-02','an OE number finds its part');
select is(public.xref_search('4955595')->'direct'->0->>'match','exact','… as an exact match');
select is((select array_agg(x->>'sku' order by x->>'sku') from jsonb_array_elements(public.xref_search('4955595')->'linked') x),
          array['EL123456','FAR999'],'one link step: parts sharing any OE or cross ref number are added');
select is((select x->'via' from jsonb_array_elements(public.xref_search('4955595')->'linked') x where x->>'sku'='EL123456'),
          '["4025300"]'::jsonb,'linked parts say which number links them');
select ok(not public.xref_search('4955595')::text like '%FAR1000%','links are followed one step only');
select is(public.xref_search('4025300')->'direct'->0->>'sku','EL123456','searching the other OE number…');
select is(public.xref_search('4025300')->'direct_total','2'::jsonb,'… finds both parts that list it');
select is((select count(*)::int from jsonb_array_elements(public.xref_search('4025300')->'linked') x where x->>'sku'='FAR999'),1,'… and links on from both');

select is(upper(public.xref_search('1445119000')->'direct'->0->>'sku'),'MH037WN5601','a cross ref number matches without its dashes');
select is(public.xref_search('14 451190-00')->'direct'->0->>'matched_number','14-451190-00','the number is shown as imported');
select is(public.xref_search('lx3141')->'direct'->0->>'sku','FEB173607','search ignores case');
select is(public.xref_search('C331460')->'direct'->0->>'match','starts','partial numbers match the start');
select is(public.xref_search('45119')->'direct'->0->>'match','contains','partial numbers match inside a number');
select is(jsonb_array_length(public.xref_search('45')->'direct'),0,'two characters only match the start of a number');
select is(public.xref_search('p0400')->'direct'->0->>'sku','P040076','our SKU is searchable');
select is(public.xref_search('mh037wn5601')->'direct'->0->>'matched_kind','sku','… and reported as the SKU');

select is(jsonb_array_length(public.xref_search('gasket cummins')->'direct'),2,'description words all have to appear');
select is(public.xref_search('gasket cummins')->'direct'->0->>'match','description','… and are reported as description matches');
select is(jsonb_array_length(public.xref_search('gasket cummins')->'linked'),0,'description matches are not linked further');
select is(jsonb_array_length(public.xref_search('liner volvo d13')->'direct'),1,'words can be in any order');
select is(jsonb_array_length(public.xref_search('gasket%')->'direct'),0,'% typed by the user is taken literally');
select is(public.xref_search('x')->'direct','[]'::jsonb,'one character returns nothing');
select is(public.xref_search(null)->'direct','[]'::jsonb,'empty search returns nothing');
select is(jsonb_array_length(public.xref_search('isx',1)->'direct'),1,'results are limited');
select is((public.xref_search('isx',1)->>'direct_total')::int,4,'… and the total is still given');

-- Part details
select is(public.xref_get_part('mh037wn5601')->>'description','LINER KIT VOLVO D13 (UPDATED)','details show the latest import of the SKU');
select is(public.xref_get_part('MH037WN5601')->>'brand_description','Mahle is a reputable supplier.','brand description is kept when a later row leaves it empty');
select is(public.xref_get_part('MH037WN5601')->'cross_numbers','["89886110", "861612", "14-451190-00"]'::jsonb,'cross ref numbers in file order');
select is(public.xref_get_part('MH037WN5601')->'specs','[{"label":"Cyl. Bore","value":"131 mm"},{"label":"","value":"Wet liner"}]'::jsonb,'specs keep their order and drop empty ones');
select is(public.xref_get_part('MH037WN5601')->>'package_weight_kg',null,'a replaced row replaces the package sizes too');
select is(public.xref_get_part('MH037WN5601')->>'updated_by','Xref Admin','details show who imported it');
select is((public.xref_get_part('P040076')->>'package_length_cm')::numeric,5.08,'a decimal comma is read');
select is(jsonb_array_length(public.xref_get_part('FEB173607')->'specs'),2,'a label used twice is kept twice');
select is(public.xref_get_part('VR02-10808-02')->'oe_numbers','["4352144", "4955595", "4025300"]'::jsonb,'OE numbers in file order');
select is(public.xref_get_part('NOPE'),null,'an unknown SKU returns nothing');

-- Parts missing from a later file stay
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((public.xref_import('[{"sku":"P040076","brand":"PAI","description":"CONROD BOLT CUMMINS ISX","oe_numbers":["3678574","3678575"]}]'::jsonb,'update.xlsx',null,true)->>'replaced')::int,1,'a new file replaces the SKU');
select is((public.xref_summary()->>'parts')::int,8,'parts not in the new file are kept');
select is(public.xref_get_part('P040076')->'specs','[]'::jsonb,'the replaced row has no specs left from before');
select is(public.xref_search('3678575')->'direct'->0->>'sku','P040076','the new number is searchable');
select is(jsonb_array_length(public.xref_summary()->'imports'),2,'administrators see the import history');
select is((select x->>'created' from jsonb_array_elements(public.xref_summary()->'imports') x where x->>'file_name'='Parts_info_002.xlsx'),'8','… with what each import did');

-- Who can search
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(public.xref_search('4955595')->'direct'->0->>'sku','VR02-10808-02','management can search');
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok($$select public.xref_search('4955595')$$,'42501',null,'users without the Sales Desk cannot search');
select throws_ok($$select public.xref_get_part('P040076')$$,'42501',null,'… or open a part');
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000005","role":"authenticated"}';
select throws_ok($$select public.xref_search('4955595')$$,'42501',null,'inactive users cannot search');
select throws_ok($$select count(*) from xref.parts$$,'42501',null,'the tables cannot be read directly');

-- Broad searches
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((public.xref_import((select jsonb_agg(jsonb_build_object('sku','BULK'||g,'description','BULK PART','oe_numbers',jsonb_build_array('99'||g))) from generate_series(1,250) g),'bulk.xlsx',null,true)->>'created')::int,250,'250 more parts imported');
set local request.jwt.claims='{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.xref_search('99')->>'linked_skipped','true','linking is skipped when over 200 parts match by number');
select is(public.xref_search('99')->>'direct_total','250','… but every match is still counted');
select is(public.xref_search('991')->>'linked_skipped','false','a narrower search links again');
select is(public.xref_search('4955595')->>'more','false','a normal search is complete');

select * from finish();
rollback;
