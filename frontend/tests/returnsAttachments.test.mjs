import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimFileType, validateClaimFiles, MAX_CLAIM_FILE_BYTES } from '../src/returnsAttachments.ts'

test('supports the requested image and document formats, including blank browser MIME', () => {
  for (const extension of ['jpg','jpeg','png','gif','webp','pdf','doc','docx','xls','xlsx']) {
    assert.ok(claimFileType({ name: `evidence.${extension.toUpperCase()}`, type: '', size: 123 }))
  }
})
test('rejects executable, HTML, SVG and mismatched MIME uploads', () => {
  for (const extension of ['exe','html','svg','js','zip']) {
    assert.throws(() => claimFileType({ name: `file.${extension}`, type: '', size: 123 }))
  }
  assert.throws(() => claimFileType({ name: 'file.pdf', type: 'text/html', size: 123 }))
})
test('enforces empty-file and exact size boundaries', () => {
  assert.throws(() => claimFileType({ name: 'file.pdf', type: '', size: 0 }))
  assert.equal(claimFileType({ name: 'file.pdf', type: '', size: MAX_CLAIM_FILE_BYTES }), 'application/pdf')
  assert.throws(() => claimFileType({ name: 'file.pdf', type: '', size: MAX_CLAIM_FILE_BYTES + 1 }))
})
test('counts saved and pending files together without silently truncating a selection', () => {
  const file = { name: 'file.pdf', type: 'application/pdf', size: 123 }
  assert.doesNotThrow(() => validateClaimFiles([file, file], 8))
  assert.throws(() => validateClaimFiles([file, file], 9))
  assert.throws(() => validateClaimFiles([file], 10))
})
