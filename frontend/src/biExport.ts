// Excel exports of charts and tables (built in the browser with exceljs, loaded on demand).
import type {FieldValue,NumberFormat} from './biApps'

export type ExportTable={title:string;headers:string[];formats:(NumberFormat|undefined)[];rows:FieldValue[][]}

// Excel number formats for the app's formats
export function excelFormat(format?:NumberFormat){
  switch(format){
    case 'money':return '"R" #,##0.00'
    case 'integer':return '#,##0'
    case 'percent':return '0.0%'
    case 'number':return '#,##0.00'
    default:return undefined
  }
}

// Sheet names: at most 31 characters, none of []:*?/\ and unique
export function sheetNames(titles:string[]){
  const used=new Set<string>()
  return titles.map((title,i)=>{
    const base=(title.replace(/[[\]:*?/\\]+/g,' ').replace(/\s+/g,' ').trim()||`Chart ${i+1}`).slice(0,31)
    let name=base,n=2
    while(used.has(name.toLowerCase())){const suffix=` (${n++})`;name=base.slice(0,31-suffix.length)+suffix}
    used.add(name.toLowerCase());return name
  })
}

// Cell values: numbers stay numbers, ISO dates become dates, booleans Yes/No
export function excelValue(value:FieldValue):string|number|Date|null{
  if(value===null||value===undefined)return null
  if(typeof value==='number')return value
  if(typeof value==='boolean')return value?'Yes':'No'
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return new Date(`${value}T00:00:00Z`)
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)){const d=new Date(value);return Number.isNaN(d.getTime())?value:d}
  return value
}

export function safeFileName(name:string){return name.replace(/[^\w\- ]+/g,'').trim()||'export'}

export async function workbookBuffer(tables:ExportTable[]){
  const {default:ExcelJS}=await import('exceljs')
  const book=new ExcelJS.Workbook()
  book.creator='Impala Hub Reporting';book.created=new Date()
  const names=sheetNames(tables.map(t=>t.title))
  tables.forEach((table,t)=>{
    const sheet=book.addWorksheet(names[t],{views:[{state:'frozen',ySplit:1}]})
    sheet.addRow(table.headers).font={bold:true}
    for(const row of table.rows)sheet.addRow(row.map(excelValue))
    table.headers.forEach((header,c)=>{
      const column=sheet.getColumn(c+1)
      const format=excelFormat(table.formats[c])
      if(format)column.numFmt=format
      if(table.rows.some(row=>typeof row[c]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row[c] as string)))column.numFmt='yyyy-mm-dd'
      column.width=Math.min(50,Math.max(10,header.length+2,...table.rows.slice(0,200).map(row=>String(row[c]??'').length+2)))
    })
    sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:Math.max(1,table.headers.length)}}
  })
  return book.xlsx.writeBuffer()
}

export async function downloadWorkbook(tables:ExportTable[],fileName:string){
  const buffer=await workbookBuffer(tables)
  const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${safeFileName(fileName)}.xlsx`;link.click()
  setTimeout(()=>URL.revokeObjectURL(link.href),1000)
}
