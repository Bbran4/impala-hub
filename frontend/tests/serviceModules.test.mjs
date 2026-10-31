import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Use the same bundler as Vite so the browser services can run with injected
// clients, without a browser, credentials, or any live database/network calls.
const root = fileURLToPath(new URL("../", import.meta.url));
const bundled = await build({
  stdin: {
    contents: `export * from './src/rfqService.ts'; export * from './src/returnsService.ts'; export * from './src/postsService.ts'; export * from './src/campaignsService.ts'`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  define: { "import.meta.env": "{}" },
});
const {
  createRfqService,
  createReturnsService,
  createPostsService,
  createCampaignsService,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const success = (data) => ({ data, error: null });
const session = {
  access_token: `header.${btoa('{"session_id":"test"}')}.signature`,
  user: { id: "signed-in-user" },
};
const auth = {
  async getSession() {
    return success({ session });
  },
};
function query(resolve) {
  const calls = [];
  const builder = {
    calls,
    then(onfulfilled, onrejected) {
      return Promise.resolve(resolve(calls)).then(onfulfilled, onrejected);
    },
  };
  for (const name of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "is",
    "in",
    "order",
    "range",
    "limit",
    "lt",
    "single",
  ]) {
    builder[name] = (...args) => {
      calls.push([name, ...args]);
      return builder;
    };
  }
  return builder;
}

test("RFQ commands use transactional RPCs; errors and conversion cardinality are preserved", async () => {
  const calls = [];
  const client = {
    auth,
    rpc(name, args) {
      calls.push([name, args]);
      if (name === "convert_sales_desk_rfq_to_invoice")
        return {
          single() {
            calls.push(["single"]);
            return success({ id: "invoice", rfq_no: "Q1INV" });
          },
        };
      if (name === "archive_sales_desk_rfq") return success(null);
      return success({ id: "quote", rfq_no: "Q1" });
    },
  };
  const service = createRfqService(client);
  const values = {
    customer_name: "Customer",
    media_platform_id: "email",
    received_at: "2026-10-30T08:00:00Z",
  };
  await service.create(values);
  await service.update("quote", { remarks: "Changed" });
  await service.claim("quote");
  assert.equal((await service.convertToInvoice("quote")).id, "invoice");
  await service.archive("quote");
  assert.deepEqual(calls, [
    ["create_sales_desk_rfq", { p_values: values }],
    [
      "update_sales_desk_rfq",
      { p_id: "quote", p_values: { remarks: "Changed" } },
    ],
    ["claim_sales_desk_rfq", { p_id: "quote" }],
    ["convert_sales_desk_rfq_to_invoice", { source_id: "quote" }],
    ["single"],
    ["archive_sales_desk_rfq", { p_id: "quote" }],
  ]);
  await service.sendForApproval("quote", { status_id: "completed", document_number: "DOC-1", remarks: "Ready" });
  assert.deepEqual(calls.at(-1),["submit_sales_desk_rfq_for_approval",{p_id:"quote",p_values:{status_id:"completed",document_number:"DOC-1",remarks:"Ready"}}]);
  await service.sendForApproval("quote");
  assert.deepEqual(calls.at(-1),["submit_sales_desk_rfq_for_approval",{p_id:"quote",p_values:{}}]);
  await service.reviewApproval("quote",3,"approved","Checked quotation");
  assert.deepEqual(calls.at(-1),["review_sales_desk_approval",{p_id:"quote",p_expected_revision:3,p_decision:"approved",p_note:"Checked quotation"}]);
  client.rpc = () => ({ data: null, error: { message: "Not permitted" } });
  await assert.rejects(service.claim("quote"), /Not permitted/);
});

test("RFQ display metadata is cached across concurrent service calls", async () => {
  let requests = 0;
  const service = createRfqService({
    auth,
    async rpc(name) {
      assert.equal(name, "sales_desk_session_context");
      requests++;
      return success({ id: session.user.id, role: "salesperson" });
    },
  });
  await Promise.all([service.me(), service.me(), service.me()]);
  assert.equal(requests, 1);
});

test("RFQ lists request one server-filtered page and normalize joined fields",async()=>{
  const calls=[];
  const service=createRfqService({rpc(name,args){calls.push([name,args]);return success({items:[{id:'one',media_platform:{name:'Email'},status:{name:'New',is_closed:false},sales_code:{code:'AB'}}],total:1501,limit:50,offset:100})}});
  const result=await service.list({search:'Customer',sort:'received_desc'},100);
  assert.equal(calls.length,1);assert.equal(calls[0][0],'sales_desk_rfq_page');
  assert.deepEqual(calls[0][1],{p_filters:{search:'Customer',sort:'received_desc'},p_limit:50,p_offset:100});
  assert.equal(result.items.length,1);assert.equal(result.total,1501);assert.equal(result.items[0].status,'New');assert.equal(result.items[0].sales_code,'AB');
});

test("Returns lists use bounded filtered RPCs and only exports request subsequent pages",async()=>{
  const calls=[];
  const service=createReturnsService({rpc(name,args){calls.push([name,args]);return success({items:[{id:String(args.p_offset)}],total:3,limit:args.p_limit,offset:args.p_offset,summary:{total:3}})}});
  const filters={status:'In Progress',sla:'overdue',search:'customer'};
  const page=await service.list(filters,50);assert.equal(page.total,3);assert.equal(calls.length,1);
  assert.deepEqual(calls[0],['returns_claim_page',{p_filters:filters,p_offset:50,p_limit:50,p_summary:true}]);
  calls.length=0;const rows=await service.exportRows(filters);assert.equal(rows.length,3);assert.equal(calls.length,3);
  assert.ok(calls.every(([,args])=>args.p_summary===false && args.p_limit===200 && args.p_filters===filters));
});

test("claim writes exclude identities, history and browser metadata; normalize supplier receipts", async () => {
  const writes = [];
  const service = createReturnsService({
    auth,
    from(table) {
      assert.equal(table, "returns_claims");
      return query((calls) => {
        writes.push(
          calls.find((call) => call[0] === "insert" || call[0] === "update")[1],
        );
        return success({ id: "claim", claim_no: "RC1" });
      });
    },
  });
  const values = {
    customer: "Customer",
    status: "In Progress",
    supplier_name: "Supplier",
    credit_amount: "0",
    credit_received_on: "2026-10-30",
    credit_reference: "CN1",
    id: "forged",
    claim_no: "forged",
    created_by: "forged",
    audit_history: [{ action: "forged" }],
  };
  await service.create(values);
  await service.update("claim", values);
  for (const write of writes) {
    assert.equal(write.credit_amount, 0);
    assert.equal(write.updated_by, session.user.id);
    for (const key of ["id", "claim_no", "audit_history"])
      assert.equal(key in write, false);
  }
  assert.equal(writes[0].created_by, session.user.id);
  assert.equal("created_by" in writes[1], false);
  await assert.rejects(
    service.update("claim", {
      credit_received_on: "2026-10-30",
      credit_amount: "bad",
    }),
    /Credit amount/,
  );
});

test("a failed attachment insert cleans up its uploaded object and returns the failure", async () => {
  const uploaded = [],
    removed = [];
  const client = {
    auth,
    storage: {
      from() {
        return {
          async upload(name) {
            uploaded.push(name);
            return success({});
          },
          async remove(names) {
            removed.push(...names);
            return success({});
          },
        };
      },
    },
    from() {
      return query((calls) =>
        calls.some((call) => call[0] === "insert")
          ? { data: null, error: { message: "Insert denied" } }
          : { ...success([]), count: 0 },
      );
    },
  };
  const service = createReturnsService(client);
  await assert.rejects(
    service.uploadAttachment(
      "claim",
      new File(["data"], "../supplier invoice.pdf", {
        type: "application/pdf",
      }),
    ),
    /Insert denied/,
  );
  assert.equal(uploaded.length, 1);
  assert.deepEqual(removed, uploaded);
  assert.match(
    uploaded[0],
    /^signed-in-user\/claim\/[a-z0-9-]+-supplier_invoice.pdf$/,
  );
});

test("posts save through the integrity RPC and retain filtered paging and history cursors", async () => {
  const calls = [],
    history = [];
  const service = createPostsService({
    rpc(name, args) {
      calls.push([name, args]);
      if (name === "marketing_post_page")
        return success({ items: [], total: 1501, summary: [] });
      return {
        single() {
          return success({ id: args.p_id || "new-post" });
        },
      };
    },
    from(table) {
      assert.equal(table, "audit_log");
      return query((entries) => {
        history.push(entries);
        return success([]);
      });
    },
  });
  const saved = await service.update("post", { campaign_id: "campaign" });
  assert.equal(saved.id, "post");
  const result = await service.list({
    month: "2026-10-01",
    campaign: "campaign",
    search: "launch",
    offset: 100,
    preview: true,
  });
  assert.equal(result.total, 1501);
  assert.equal(calls[0][0], "save_marketing_post");
  assert.deepEqual(calls[0][1], {
    p_id: "post",
    p_values: { campaign_id: "campaign" },
  });
  assert.equal(calls[1][1].p_offset, 100);
  assert.equal(calls[1][1].p_search, "launch");
  assert.equal(calls[1][1].p_limit, 50);
  await service.history("post", 123);
  assert.ok(
    history[0].some(
      (call) => call[0] === "lt" && call[1] === "id" && call[2] === 123,
    ),
  );
});

test("campaign creation uses the signed-in owner and type reordering stays atomic", async () => {
  const inserted = [],
    commands = [];
  const service = createCampaignsService({
    auth,
    from(table) {
      assert.equal(table, "campaigns");
      return query((calls) => {
        const values = calls.find((call) => call[0] === "insert")[1];
        inserted.push(values);
        return success({ ...values, id: "campaign" });
      });
    },
    async rpc(name, args) {
      commands.push([name, args]);
      return success(null);
    },
  });
  await service.create({
    name: "Launch",
    objective: "Awareness",
    stage: "new",
    campaign_type: "Product",
  });
  assert.equal(inserted[0].owner_id, session.user.id);
  await service.reorderTypes(["Product", "Brand"]);
  assert.deepEqual(commands, [
    ["admin_reorder_campaign_types", { p_names: ["Product", "Brand"] }],
  ]);
});

test("missing Supabase configuration fails before any network request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Network must not be used");
  };
  try {
    for (const service of [
      createRfqService(null),
      createReturnsService(null),
      createPostsService(null),
      createCampaignsService(null),
    ]) {
      await assert.rejects(service.list(), /Supabase is not configured/);
    }
    await assert.rejects(
      createRfqService(null).claim("quote"),
      /Supabase is not configured/,
    );
    await assert.rejects(
      createReturnsService(null).create({}),
      /Supabase is not configured/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("post media is validated before upload or save, while multi-photo drafts remain supported", async () => {
  let calls=0;
  const service=createPostsService({
    rpc(){calls++;return {single(){return success({id:'multi'})}}},
    auth:{getSession(){calls++;throw new Error('must not run')}},
  });
  await assert.rejects(service.upload(new File(['pdf'],'bad.pdf',{type:'application/pdf'})),/JPG/);
  await assert.rejects(service.create({media:[{url:'http://insecure/image'}]}),/HTTPS/);
  await assert.rejects(service.update('post',{media:Array(11).fill({url:'https://storage/image'})}),/10 images/);
  assert.equal(calls,0);
  assert.equal((await service.create({media:[{url:'https://storage/one.jpg'},{url:'https://storage/two.jpg'}]})).id,'multi');
  assert.equal(calls,1);
});

test("service contracts reject server-owned fields and malformed filters at compile time", () => {
  const config = ts.readConfigFile(
    path.join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(
    [
      ...parsed.fileNames,
      path.join(root, "tests/serviceContracts.typecheck.ts"),
    ],
    parsed.options,
  );
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(
    errors.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
});


test('deleted or inaccessible RFQ links produce a clear message without loading attachments', async () => {
  for (const result of [{data:null,error:{code:'PGRST116',message:'0 rows'}},{data:null,error:null}]) {
    let reads = 0;
    const service = createRfqService({from(table) { reads++; assert.equal(table,'sales_desk_rfqs'); return query(() => result); }});
    await assert.rejects(() => service.detail('gone'), /RFQ was deleted or is no longer available/);
    assert.equal(reads,1);
  }
});
test('RFQ link network errors remain errors rather than being labelled deleted', async () => {
  const service = createRfqService({from() { return query(() => ({data:null,error:{message:'Network unavailable'}})); }});
  await assert.rejects(() => service.detail('rfq'), /Network unavailable/);
});
