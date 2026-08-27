/**
 * Log estruturado minimo (JSON), sem dependencia nova: um `console.warn` que
 * sempre imprime um objeto serializado, nunca texto solto. E o ponto de
 * entrada unico para logs de aviso — o bloco de observabilidade completo
 * pode trocar a implementacao interna (por exemplo por pino) sem mudar
 * nenhum call site, porque todos passam por esta funcao.
 *
 * Nunca inclua aqui dados financeiros completos (saldo, diferenca, payload
 * de transacao) nem dados pessoais — so o suficiente para localizar e
 * correlacionar o evento (correlationId, walletId, contadores).
 */
export function logStructuredWarning(event: string, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      event,
      level: 'warn',
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
}
