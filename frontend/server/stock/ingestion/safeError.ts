export function safeStockIngestionError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Stock ingestion failed.'
  return message
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[private key redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/(api[_ -]?key|token|password|secret|authorization|cookie)\s*[:=]\s*[^\r\n,;]*/gi, '$1=[redacted]')
    .replace(/https?:\/\/\S+/gi, '[external URL]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, 1000)
}
