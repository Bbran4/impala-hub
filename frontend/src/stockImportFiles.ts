export type StockImportDataset = 'booking' | 'reordering'
export type ImportField = {
  key: string
  label: string
  required?: boolean
  kind: 'text' | 'integer' | 'number' | 'supplier_type'
  min?: number
  nullable?: boolean
  scale?: number
  aliases: string[]
}
export type ParsedImportTable = {
  fileName: string
  fileChecksum: string
  sheetName: string
  headers: string[]
  rows: string[][]
  sourceRowNumbers: number[]
  formulaCells: string[]
}
export type ImportMapping = Record<string, string>
export type ImportValidationError = { row: number | null; field?: string; message: string }

const text = (key: string, label: string, aliases: string[], required = false): ImportField => ({ key, label, required, kind: 'text', aliases })
const integer = (key: string, label: string, aliases: string[], min?: number): ImportField => ({ key, label, kind: 'integer', aliases, min })
const number = (key: string, label: string, aliases: string[], min?: number, scale=4, nullable=false): ImportField => ({ key, label, kind: 'number', aliases, min, scale, nullable })

export const BOOKING_IMPORT_FIELDS: ImportField[] = [
  text('id','Source ID',['id','source id','legacy id']), text('franchise','Franchise',['franchise','brand','make']),
  text('part_number','Part Number',['part number','part no','partnumber','sku','item code','stock code'],true),
  text('description','Description',['description','part description','item description']), text('unit_size','Unit Size',['unit size','pack size','uom','unit']),
  integer('on_picking_slip_er','On Picking Slip ER',['on picking slip er','picking slip er','on pick er'],0),
  integer('qoh_er','QOH ER',['qoh er','stock er','er qoh','qty on hand er']), integer('max_er','Max ER',['max er','maximum er','er max'],0),
  integer('on_picking_slip_pta','On Picking Slip PTA',['on picking slip pta','picking slip pta','on pick pta'],0),
  integer('qoh_pta','QOH PTA',['qoh pta','stock pta','pta qoh','qty on hand pta']), integer('max_pta','Max PTA',['max pta','maximum pta','pta max'],0),
  integer('qoh_wh','QOH WH',['qoh wh','stock wh','warehouse qoh','qty on hand warehouse']), integer('max_wh','Max WH',['max wh','maximum wh','warehouse max'],0),
  text('bin_er','Bin ER',['bin er','er bin','bin location er']), text('bin_pta','Bin PTA',['bin pta','pta bin','bin location pta']), text('bin_wh','Bin WH',['bin wh','warehouse bin','bin location warehouse']),
]

export const REORDERING_IMPORT_FIELDS: ImportField[] = [
  text('id','Source ID',['id','source id','legacy id']), text('franchise','Franchise',['franchise','brand','make']),
  text('part_number','Part Number',['part number','part no','partnumber','sku','item code','stock code'],true),
  text('description','Description',['description','part description','item description']),
  text('alt_1','Alternative 1',['alt 1','alternative 1','alternative part 1']), text('alt_2','Alternative 2',['alt 2','alternative 2','alternative part 2']),
  text('alt_3','Alternative 3',['alt 3','alternative 3','alternative part 3']), text('alt_4','Alternative 4',['alt 4','alternative 4','alternative part 4']),
  number('qoh_er','QOH ER',['qoh er','stock er','er qoh','qty on hand er']), number('safety_er','Safety ER',['safety er','safety stock er','er safety'],0),
  number('qoh_pta','QOH PTA',['qoh pta','stock pta','pta qoh','qty on hand pta']), number('safety_pta','Safety PTA',['safety pta','safety stock pta','pta safety'],0),
  number('qoh_wh','QOH WH',['qoh wh','stock wh','warehouse qoh','qty on hand warehouse']), number('safety_wh','Safety WH',['safety wh','safety stock wh','warehouse safety'],0),
  number('global_safety','Global Safety',['global safety','total safety','safety stock total'],0), number('qty_on_order','Qty on Order',['qty on order','quantity on order','on order'],0),
  number('qty_to_order','Qty to Order',['qty to order','quantity to order','to order'],0), text('lead_time','Lead Time',['lead time','leadtime']),
  number('avg_sales','Average Sales',['average sales','avg sales','average monthly sales']), number('sales_this_month','Sales This Month',['sales this month','month sales','mtd sales']),
  text('gauge','Gauge',['gauge','rating','stock gauge']), text('supplier','Supplier',['supplier','vendor']), number('last_cost','Last Cost',['last cost','cost','latest cost'],0,2,true),
  { key:'supplier_type', label:'Supplier Type', kind:'supplier_type', aliases:['supplier type','vendor type','local international'] },
]

export const fieldsForDataset = (dataset: StockImportDataset) => dataset === 'booking' ? BOOKING_IMPORT_FIELDS : REORDERING_IMPORT_FIELDS
const normalizeHeader = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,'')

function parseWithDelimiter(input: string, delimiter: string) {
  if (input.includes('\0')) throw new Error('The delimited file contains a NUL character.')
  const rows: string[][] = []; let row: string[] = []; let value = ''; let state:'start'|'plain'|'quoted'|'after'='start'
  for (let index=0; index<input.length; index++) {
    const character=input[index]
    if (state==='quoted') {
      if (character==='"' && input[index+1]==='"') { value+='"'; index++ }
      else if (character==='"') state='after'
      else value+=character
    } else if (state==='after') {
      if (character===delimiter) { row.push(value); value=''; state='start' }
      else if (character==='\n' || character==='\r') { if(character==='\r'&&input[index+1]==='\n')index++;row.push(value);rows.push(row);row=[];value='';state='start' }
      else if (!/\s/.test(character)) throw new Error('The delimited file contains characters after a closing quote.')
    } else if (character==='"') {
      if (state!=='start') throw new Error('The delimited file contains a quote inside an unquoted value.')
      state='quoted'
    }
    else if (character===delimiter) { row.push(value); value=''; state='start' }
    else if (character==='\n' || character==='\r') {
      if (character==='\r' && input[index+1]==='\n') index++
      row.push(value); rows.push(row); row=[]; value=''; state='start'
    } else { value+=character; state='plain' }
  }
  if (state==='quoted') throw new Error('The delimited file contains an unclosed quoted value.')
  if (value || row.length) { row.push(value); rows.push(row) }
  return rows.filter((values) => values.some((entry) => entry.trim()))
}

export function parseDelimitedText(input: string) {
  const content=input.replace(/^\uFEFF/,'')
  const failures:Error[]=[]; const candidates:{delimiter:string;rows:string[][]}[]=[]
  for (const delimiter of [',',';','\t']) { try { candidates.push({delimiter,rows:parseWithDelimiter(content,delimiter)}) } catch(error) { failures.push(error as Error) } }
  if (!candidates.length) throw failures[0] || new Error('Could not parse the delimited file.')
  candidates.sort((a,b) => Math.max(0,...b.rows.slice(0,20).map(row=>row.length))-Math.max(0,...a.rows.slice(0,20).map(row=>row.length)))
  const selected=candidates[0]
  if (!selected.rows.length || Math.max(...selected.rows.slice(0,20).map(row=>row.length))<2) throw failures[0] || new Error('The file must contain a header row with at least two columns.')
  const tableStart=selected.rows.findIndex((row) => row.length>=2)
  const tableWidth=selected.rows[tableStart].length
  if (selected.rows.slice(tableStart).some((row) => row.length!==tableWidth)) throw new Error('The delimited file contains inconsistent column counts.')
  return selected.rows
}

function aliasScore(headers: string[], fields: ImportField[]) {
  const normalized=new Set(headers.map(normalizeHeader))
  return fields.reduce((score,field) => score + (field.aliases.some((alias) => normalized.has(normalizeHeader(alias))) ? (field.required ? 5 : 1) : 0),0)
}

function selectHeaderRow(rows: string[][], fields: ImportField[]) {
  let best={ index:-1, score:-1 }
  rows.slice(0,20).forEach((row,index) => { const score=aliasScore(row,fields); if (score>best.score) best={index,score} })
  if (best.index<0 || best.score<5) throw new Error('Could not find a header containing a Part Number column.')
  return best.index
}

export function autoMapImportHeaders(headers: string[], fields: ImportField[]) {
  const mapping: ImportMapping={}; const claimed=new Set<string>()
  for (const field of fields) {
    const header=headers.find((candidate) => !claimed.has(candidate) && field.aliases.some((alias) => normalizeHeader(alias)===normalizeHeader(candidate)))
    mapping[field.key]=header || ''
    if (header) claimed.add(header)
  }
  return mapping
}

function parseNumber(value: string, field: ImportField) {
  const trimmed=value.trim()
  if (!trimmed) return field.nullable ? null : 0
  const negative=/^\(.*\)$/.test(trimmed)
  const normalized=trimmed.replace(/^\((.*)\)$/,'$1').replace(/\s/g,'').replace(/^R/i,'')
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized)) return Number.NaN
  const unsigned=normalized.replace(/^[+-]/,'').replace(/,/g,''); const [whole,fraction='']=unsigned.split('.')
  if (field.kind==='integer' && whole.length>10) return Number.NaN
  if (field.kind==='number' && (fraction.length>(field.scale ?? 4) || whole.replace(/^0+/,'').length>16-(field.scale ?? 4))) return Number.NaN
  const result=Number(normalized.replace(/,/g,'')); const signed=negative ? -result : result
  if (field.kind==='integer' && (signed < -2147483648 || signed > 2147483647)) return Number.NaN
  return signed
}

export function buildStockImportRows(table: ParsedImportTable, dataset: StockImportDataset, mapping: ImportMapping) {
  const fields=fieldsForDataset(dataset); const errors: ImportValidationError[]=[]; const rows: Record<string,unknown>[]=[]; const keys=new Map<string,number>()
  for (const field of fields.filter((item) => item.required)) if (!mapping[field.key]) errors.push({row:null,field:field.key,message:`Map the required ${field.label} column.`})
  const mappedHeaders=Object.values(mapping).filter(Boolean)
  if (new Set(mappedHeaders).size!==mappedHeaders.length) errors.push({row:null,message:'Each source column can only be mapped once.'})
  if (table.formulaCells.length) errors.push({row:null,message:`Formulas are not supported. Paste values first (${table.formulaCells.slice(0,5).join(', ')}${table.formulaCells.length>5?'…':''}).`})
  if (errors.length) return { rows, errors }
  const headerIndexes=new Map(table.headers.map((header,index) => [header,index]))
  table.rows.forEach((sourceRow,index) => {
    const sourceRowNumber=table.sourceRowNumbers[index]
    if (!sourceRow.some((value) => String(value).trim())) return
    const output: Record<string,unknown>={}
    for (const field of fields) {
      const header=mapping[field.key]; const column=header ? headerIndexes.get(header) : undefined
      const raw=column == null ? '' : String(sourceRow[column] ?? '').trim()
      if (field.required && !raw) { errors.push({row:sourceRowNumber,field:field.key,message:`${field.label} is required.`}); continue }
      if (field.kind==='text') {
        if (/^[=+@]/.test(raw) || /^-[A-Za-z]/.test(raw)) errors.push({row:sourceRowNumber,field:field.key,message:`${field.label} starts with an unsafe spreadsheet formula character.`})
        if (field.key==='part_number' && raw.length>120) errors.push({row:sourceRowNumber,field:field.key,message:'Part Number must be 120 characters or fewer.'})
        else if (raw.length>5000) errors.push({row:sourceRowNumber,field:field.key,message:`${field.label} is too long.`})
        output[field.key]=raw
      }
      else if (field.kind==='supplier_type') {
        const supplierType=raw.toLowerCase()
        if (!['','local','international'].includes(supplierType)) errors.push({row:sourceRowNumber,field:field.key,message:'Supplier Type must be Local, International or blank.'})
        output[field.key]=supplierType
      } else {
        const parsed=parseNumber(raw,field)
        if (parsed===null) output[field.key]=null
        else if (!Number.isFinite(parsed)) errors.push({row:sourceRowNumber,field:field.key,message:`${field.label} must be a number within the supported precision.`})
        else if (field.kind==='integer' && !Number.isInteger(parsed)) errors.push({row:sourceRowNumber,field:field.key,message:`${field.label} must be a whole number.`})
        else if (field.min != null && parsed<field.min) errors.push({row:sourceRowNumber,field:field.key,message:`${field.label} must be ${field.min} or greater.`})
        if (parsed!==null) output[field.key]=parsed
      }
    }
    output.source_row_number=sourceRowNumber
    const duplicateKey=`${String(output.franchise || '').trim().toLowerCase()}\u0000${String(output.part_number || '').trim().toLowerCase()}`
    const previous=keys.get(duplicateKey)
    if (output.part_number && previous) errors.push({row:sourceRowNumber,field:'part_number',message:`Duplicate Part Number and Franchise combination; first seen on row ${previous}.`})
    else if (output.part_number) keys.set(duplicateKey,sourceRowNumber)
    rows.push(output)
  })
  if (!rows.length) errors.push({row:null,message:`The ${dataset === 'booking' ? 'Stock Booking' : 'Stock Reordering'} file contains no data rows.`})
  return { rows, errors }
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array) {
  const source=bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest=await crypto.subtle.digest('SHA-256',source)
  return Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('')
}

export async function combineStockImportChecksums(bookingChecksum: string, reorderingChecksum: string) {
  if (!/^[0-9a-f]{64}$/i.test(bookingChecksum) || !/^[0-9a-f]{64}$/i.test(reorderingChecksum)) throw new Error('Both source checksums must be SHA-256 values.')
  return sha256Hex(new TextEncoder().encode(`${bookingChecksum}:${reorderingChecksum}`))
}

export async function parseStockImportFile(file: File, dataset: StockImportDataset): Promise<ParsedImportTable> {
  if (file.size===0) throw new Error('The selected file is empty.')
  if (file.size>25*1024*1024) throw new Error('Stock import files may not exceed 25 MB.')
  const extension=file.name.split('.').pop()?.toLowerCase(); const bytes=await file.arrayBuffer(); const fields=fieldsForDataset(dataset)
  const checksum=await sha256Hex(bytes)
  if (extension==='csv' || extension==='tsv') {
    let decoded:string
    try { decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes) } catch { throw new Error('The delimited file is not valid UTF-8.') }
    const rows=parseDelimitedText(decoded); const headerIndex=selectHeaderRow(rows,fields)
    const headers=rows[headerIndex].map((header,index) => String(header).trim() || `Column ${index+1}`)
    if (new Set(headers.map(normalizeHeader)).size!==headers.length) throw new Error('Column headers must be unique after punctuation and spacing are normalized.')
    const data=rows.slice(headerIndex+1)
    if (data.length>100000) throw new Error('Stock import files may not exceed 100,000 data rows.')
    return {fileName:file.name,fileChecksum:checksum,sheetName:'CSV',headers,rows:data,sourceRowNumbers:data.map((_,index)=>headerIndex+index+2),formulaCells:[]}
  }
  if (extension!=='xlsx') throw new Error('Choose a CSV, TSV or XLSX file. Legacy XLS files are not supported.')
  const module=await import('exceljs'); const excel=module.default || module; const workbook=new excel.Workbook()
  await workbook.xlsx.load(bytes)
  let selected: { sheet: any; rows: string[][]; score: number; headerIndex: number; formulas: string[] } | null=null
  workbook.eachSheet((sheet:any) => {
    if (sheet.state && sheet.state!=='visible') return
    const rows:string[][]=[]; const formulas:string[]=[]
    sheet.eachRow({includeEmpty:false},(row:any,rowNumber:number) => {
      if (row.cellCount>100) throw new Error(`Worksheet ${sheet.name} exceeds the 100-column limit.`)
      const values:string[]=[]
      for (let column=1; column<=row.cellCount; column++) {
        const cell=row.getCell(column); const cellValue=cell.value
        if (cellValue && typeof cellValue==='object' && 'formula' in cellValue) formulas.push(`${sheet.name}!${cell.address}`)
        values.push(cell.text?.trim?.() || String((cellValue && typeof cellValue==='object' && 'result' in cellValue ? cellValue.result : cellValue) ?? '').trim())
      }
      while (values.length && !values[values.length-1]) values.pop()
      rows[rowNumber-1]=values
    })
    const compact=Array.from({length:rows.length},(_,index)=>rows[index] || [])
    try { const headerIndex=selectHeaderRow(compact,fields); const score=aliasScore(compact[headerIndex],fields); if (!selected || score>selected.score) selected={sheet,rows:compact,score,headerIndex,formulas} } catch { /* Sheet does not match this dataset. */ }
  })
  if (!selected) throw new Error(`No worksheet contains recognizable ${dataset === 'booking' ? 'Stock Booking' : 'Stock Reordering'} columns.`)
  const chosen=selected as { sheet:any; rows:string[][]; headerIndex:number; formulas:string[] }
  const headers=chosen.rows[chosen.headerIndex].map((header,index)=>String(header).trim() || `Column ${index+1}`)
  if (new Set(headers.map(normalizeHeader)).size!==headers.length) throw new Error(`Worksheet ${chosen.sheet.name} contains duplicate column headers after normalization.`)
  const data=chosen.rows.slice(chosen.headerIndex+1)
  if (data.length>100000) throw new Error('Stock import worksheets may not exceed 100,000 data rows.')
  return {fileName:file.name,fileChecksum:checksum,sheetName:chosen.sheet.name,headers,rows:data,sourceRowNumbers:data.map((_,index)=>chosen.headerIndex+index+2),formulaCells:chosen.formulas}
}
