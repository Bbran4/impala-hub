export type RowPage<T> = { data: T[] | null; count: number | null; error: { message: string } | null }

// Always request an exact count. A short page may reflect the server's configured
// response cap, rather than the end of the dataset. Never return a partial success.
export async function loadAllRows<T>(page: (from: number, to: number) => PromiseLike<RowPage<T>>, pageSize = 500) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Invalid page size.')
  const data: T[] = []
  let count: number | null = null
  do {
    const result = await page(data.length, data.length + pageSize - 1)
    if (result.error) throw new Error(result.error.message)
    if (result.count === null || result.count < 0) throw new Error('Could not verify the complete record count. Please reload.')
    if (count !== null && count !== result.count) throw new Error('Records changed while loading. Please reload to get a complete list.')
    count = result.count
    const rows = result.data || []
    if (!rows.length && data.length < count) throw new Error('Some records could not be loaded. Please reload.')
    data.push(...rows)
    if (data.length > count) throw new Error('Records changed while loading. Please reload.')
  } while (data.length < count)
  return { data, count, error: null }
}
