// Excel exports of charts and tables (built in the browser with exceljs, loaded on demand). The
// workbook code is shared with the report email sender (api/reporting/_excel.ts).
import {excelFormat,excelValue,sheetNames,workbookBuffer,type ExcelTable} from '../api/reporting/_excel.ts'
import type {FieldValue,NumberFormat} from './biApps'

export {excelFormat,excelValue,sheetNames,workbookBuffer}
export type ExportTable={title:string;headers:string[];formats:(NumberFormat|undefined)[];rows:FieldValue[][]}&ExcelTable

export function safeFileName(name:string){return name.replace(/[^\w\- ]+/g,'').trim()||'export'}

export async function downloadWorkbook(tables:ExportTable[],fileName:string){
  const buffer=await workbookBuffer(tables)
  const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${safeFileName(fileName)}.xlsx`;link.click()
  setTimeout(()=>URL.revokeObjectURL(link.href),1000)
}
