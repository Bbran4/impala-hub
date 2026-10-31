import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONSULTANT_FIELDS,consultantCanEdit,approvalLabel} from '../src/rfqEditing.ts';
test('consultant form edits match the narrow transactional database contract',()=>{
  assert.deepEqual(CONSULTANT_FIELDS,['status_id','document_number','remarks']);
  for(const field of CONSULTANT_FIELDS)assert.equal(consultantCanEdit(field),true);
  for(const field of ['customer_name','contact_number','email_address','query_information','received_at','claimed_at','sales_code_id','media_platform_id','approval_state','approval_requested_by'])
    assert.equal(consultantCanEdit(field),false,field);
});
test('approval states have readable labels',()=>{
  assert.equal(approvalLabel('pending'),'Awaiting manager approval');
  assert.equal(approvalLabel('approved'),'Approved');
  assert.equal(approvalLabel('changes_requested'),'Changes requested');
  assert.equal(approvalLabel(undefined),'Not requested');
});
