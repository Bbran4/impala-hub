import { chatInputMode, CHAT_COMMANDS } from '../src/chatCommands.ts'
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


test('slash opens the command picker until an RFQ prefix is recognized', () => {
 for (const value of ['/','/I','/IM','/claims','/parts','/anything','/IMPORTANT']) assert.equal(chatInputMode(value),'commands',value)
 for (const value of ['/IMP','/imp',' /IMP26103101','/IMP26103101 hello']) assert.equal(chatInputMode(value),'rfq',value)
 for (const value of ['', '@Brenden', 'person@example.com']) assert.equal(chatInputMode(value),'people',value)
})
test('RFQ is the only enabled command and other slash commands cannot parse as RFQ updates', () => {
 assert.deepEqual(CHAT_COMMANDS.filter(command=>command.enabled).map(command=>command.id),['rfq'])
 assert.ok(CHAT_COMMANDS.some(command=>command.id==='claims'&&!command.enabled))
 assert.ok(CHAT_COMMANDS.some(command=>command.id==='parts'&&!command.enabled))
 for (const value of ['/','/claims 123 hello','/parts IMP26103101 hello']) assert.equal(parseRfqCommand(value),null)
})
