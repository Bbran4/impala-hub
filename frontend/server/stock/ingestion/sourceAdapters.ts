import { fetchGoogleSheetsStock, type GoogleSheetsSourceConfig, type StockSourceEnvelope } from './googleSheets'

export type StockIngestionSource = {
  id: string
  provider: 'google_sheets' | 'qlik' | 'odbc'
  name: string
  configuration: Record<string, unknown>
  is_active: boolean
  schedule_enabled: boolean
  configured_by: string
}

type SourceAdapter = (source: StockIngestionSource) => Promise<StockSourceEnvelope>

const adapters: Partial<Record<StockIngestionSource['provider'], SourceAdapter>> = {
  google_sheets: (source) => fetchGoogleSheetsStock(source.name, source.configuration as GoogleSheetsSourceConfig),
}

export async function fetchStockSource(source: StockIngestionSource) {
  const adapter = adapters[source.provider]
  if (!adapter) throw new Error(`${source.provider.toUpperCase()} ingestion is not configured yet.`)
  return adapter(source)
}
