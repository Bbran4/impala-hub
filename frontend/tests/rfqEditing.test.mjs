import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONSULTANT_FIELDS,consultantCanEdit,approvalLabel,approvalBlockReason,approvalValidationReason} from '../src/rfqEditing.ts';
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


test('consultant can submit a newly selected completed status without saving separately', () => {
  const ready = { hasPermission: true, isQuotation: true, isCompleted: true, documentNumber: 'DOC-1', hasAttachment: true, approvalState: 'not_requested', dirty: true };
  assert.equal(approvalBlockReason(ready), null);
  assert.match(approvalBlockReason({...ready,isCompleted:false}), /completed status/);
  assert.equal(approvalBlockReason({...ready,documentNumber:'  '}), null);
  assert.match(approvalValidationReason({...ready,documentNumber:'  '}), /document number/);
  assert.equal(approvalBlockReason({...ready,hasAttachment:false}), null);
  assert.match(approvalValidationReason({...ready,hasAttachment:false}), /Upload a document/);
  assert.match(approvalBlockReason({...ready,hasPermission:false}), /permission/);
  assert.match(approvalBlockReason({...ready,isQuotation:false}), /Only quotations/);
});
test('unchanged pending or approved requests cannot be resubmitted, but business edits can', () => {
  const ready = { hasPermission:true,isQuotation:true,isCompleted:true,documentNumber:'DOC-1',hasAttachment:true,dirty:false };
  for (const approvalState of ['pending','approved']) {
    assert.ok(approvalBlockReason({...ready,approvalState}));
    assert.equal(approvalBlockReason({...ready,approvalState,dirty:true}),null);
  }
  assert.equal(approvalBlockReason({...ready,approvalState:'changes_requested'}),null);
});
