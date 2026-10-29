"""Exercise real parallel transactions in the disposable Supabase CI database."""
import concurrent.futures
import json
import os
import subprocess

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("This test runs only in the disposable GitHub Actions Supabase stack.")

containers = subprocess.check_output(
    ["docker", "ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"], text=True
).splitlines()
if len(containers) != 1:
    raise SystemExit("Expected exactly one local Supabase test database.")


def sql(statement):
    result = subprocess.run(
        ["docker", "exec", "-i", containers[0], "psql", "-U", "postgres", "-d", "postgres", "-XqAt", "-v", "ON_ERROR_STOP=1"],
        input=statement, text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


ADMIN = "99100000-0000-0000-0000-000000000001"
SALES = ["99100000-0000-0000-0000-000000000002", "99100000-0000-0000-0000-000000000003"]
days = json.loads(sql("select jsonb_build_array((now() at time zone 'Africa/Johannesburg')::date,(now() at time zone 'Africa/Johannesburg')::date+1)"))
counter_before = {day: json.loads(sql(f"select coalesce((select to_jsonb(last_value) from public.sales_desk_number_counters where business_date='{day}'),'null'::jsonb)")) for day in days}
for index, identity in enumerate([ADMIN] + SALES):
    sql(f"""insert into auth.users(id,email,raw_user_meta_data) values('{identity}','concurrency-{index}@test.invalid','{{}}');
      insert into public.profile_roles(profile_id,role_id) values('{identity}','{'administrator' if index == 0 else 'sales'}');""")
    if index:
        sql(f"update public.profiles set sales_code='CONC-{index}' where id='{identity}';")
for day in days:
    sql(f"""insert into public.sales_desk_number_counters values('{day}',98)
      on conflict(business_date) do update set last_value=greatest(sales_desk_number_counters.last_value,excluded.last_value);""")


def command(identity, expression):
    claims = json.dumps({"sub": identity, "role": "authenticated"})
    return json.loads(sql(f"begin; set local role authenticated; set local request.jwt.claims='{claims}'; select {expression}; commit;"))


def create(index):
    return command(ADMIN, f"public.create_sales_desk_rfq(jsonb_build_object('customer_name','Concurrent {index}',"
                         "'media_platform_id',(select id from public.sales_desk_media_platforms where is_active limit 1)))")


with concurrent.futures.ThreadPoolExecutor(max_workers=12) as workers:
    rows = list(workers.map(create, range(20)))
assert len({row["rfq_no"] for row in rows}) == 20
assert len({(row["business_date"], row["daily_number"]) for row in rows}) == 20
for day in {row["business_date"] for row in rows}:
    numbers = sorted(row["daily_number"] for row in rows if row["business_date"] == day)
    assert numbers == list(range(numbers[0], numbers[0] + len(numbers)))
assert any(row["daily_number"] >= 100 for row in rows)
for row in rows:
    assert row["rfq_no"].endswith(str(row["daily_number"]))
ids = ",".join(f"'{row['id']}'" for row in rows)
assert int(sql(f"select count(*) from public.sales_desk_rfq_audit where rfq_id in ({ids}) and action='created'")) == 20


def claim(identity):
    try:
        return command(identity, f"public.claim_sales_desk_rfq('{rows[0]['id']}')")
    except RuntimeError as error:
        assert "already claimed or unavailable" in str(error), error
        return None


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
    claims = list(workers.map(claim, SALES))
assert sum(result is not None for result in claims) == 1
assert int(sql(f"select count(*) from public.sales_desk_rfq_audit where rfq_id='{rows[0]['id']}' and action='claimed'")) == 1
sql(f"update public.sales_desk_rfqs set status_id=(select id from public.sales_desk_statuses where is_closed limit 1),updated_by='{ADMIN}' where id='{rows[0]['id']}';")


def convert(_):
    return command(ADMIN, f"to_jsonb(public.convert_sales_desk_rfq_to_invoice('{rows[0]['id']}'))")


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
    invoices = list(workers.map(convert, range(2)))
assert invoices[0]["id"] == invoices[1]["id"]
assert int(sql(f"select count(*) from public.sales_desk_rfq_audit where rfq_id='{rows[0]['id']}' and action='invoice_copy_created'")) == 1
# Restore the disposable stack's fixture state before the pgTAP suites run.
all_ids = ids + f",'{invoices[0]['id']}'"
restore_counter = ";".join(f"delete from public.sales_desk_number_counters where business_date='{day}'" if value is None
                           else f"update public.sales_desk_number_counters set last_value={value} where business_date='{day}'"
                           for day, value in counter_before.items())
sql(f"""begin;
  delete from public.sales_desk_rfq_audit where rfq_id in ({all_ids});
  delete from public.sales_desk_rfqs where id in ({all_ids});
  delete from auth.users where id in ('{ADMIN}','{SALES[0]}','{SALES[1]}');
  delete from public.sales_desk_sales_codes where code in ('CONC-1','CONC-2');
  {restore_counter};
  commit;""")
print("Concurrent numbering, single-winner claiming, idempotent conversion and atomic audit checks passed.")
