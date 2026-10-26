export const MAX_CLAIM_ATTACHMENTS = 10
export const MAX_CLAIM_FILE_BYTES = 15 * 1024 * 1024
const types: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
export const CLAIM_FILE_ACCEPT = Object.keys(types).map(extension => `.${extension}`).join(',')
export function claimFileType(file: { name: string; type: string; size: number }): string {
  const expected = types[file.name.split('.').pop()?.toLowerCase() || '']
  if (!expected || (file.type && file.type !== expected)) throw new Error(`${file.name}: unsupported file type. Use images, PDF, Word or Excel.`)
  if (file.size <= 0 || file.size > MAX_CLAIM_FILE_BYTES) throw new Error(`${file.name}: files must be between 1 byte and 15 MB.`)
  return expected
}
export function validateClaimFiles(files: Array<{ name: string; type: string; size: number }>, existingCount: number) {
  if (existingCount + files.length > MAX_CLAIM_ATTACHMENTS) throw new Error('A claim can have at most 10 attachments, including saved files.')
  files.forEach(claimFileType)
}
