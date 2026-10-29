export async function readMarketingResponse(response: Response, action: string) {
  const raw = await response.text()
  let result: any
  try { result = JSON.parse(raw) } catch { /* Deployment errors can be plain text or HTML. */ }
  if (!response.ok) {
    if (typeof result?.detail === 'string') throw new Error(result.detail)
    const incident = response.headers.get('x-vercel-id')
    const reason = raw.includes('FUNCTION_INVOCATION_FAILED') ? 'The server function failed to start.'
      : raw.includes('FUNCTION_INVOCATION_TIMEOUT') || response.status === 504 ? 'The server request timed out.'
      : 'The server returned an unexpected response.'
    throw new Error(`${action} failed (HTTP ${response.status}). ${reason}${incident ? ` Reference: ${incident}.` : ''}`)
  }
  if (!result || typeof result !== 'object') throw new Error(`${action} returned an invalid response. Please reload and retry.`)
  return result
}
