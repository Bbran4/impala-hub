import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRfqCommand } from '../src/rfqChat.ts'
test('RFQ command accepts mixed case, invoice links and multiline text', () => {
 assert.deepEqual(parseRfqCommand('/imp26103101 NO ATTACHMENT'),{rfqNo:'IMP26103101',body:'NO ATTACHMENT'})
 assert.deepEqual(parseRfqCommand('/IMP261031100INV First\nSecond'),{rfqNo:'IMP261031100INV',body:'First\nSecond'})
})
test('incomplete or excessive RFQ commands cannot be sent', () => {
 for (const value of ['@name','/IMP26103101','/IMP26103101   ','/anything hello','/IMP26103101 '+ 'x'.repeat(4001)]) assert.equal(parseRfqCommand(value),null)
})
