import { randomUUID } from 'node:crypto';

/**
 * String simples e limitada: letras, digitos, `_`, `.`, `:`, `-`, ate 100
 * caracteres. Suficiente para um UUID ou um token opaco de tracing vindo de
 * outro sistema, sem aceitar quebras de linha ou lixo arbitrario no header.
 */
const CORRELATION_ID_FORMAT = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * Resolve o correlationId de uma requisicao: usa o header do cliente se ele
 * vier num formato simples, senao gera um novo. Nunca rejeita a requisicao
 * so por causa de um correlationId invalido — so ignora e gera outro.
 *
 * Implementacao minima e local a este endpoint (Bloco 8b) — a centralizacao
 * via middleware/interceptor para todas as rotas fica para o bloco completo
 * de observabilidade.
 */
export function resolveCorrelationId(headerValue: string | undefined): string {
  if (headerValue && CORRELATION_ID_FORMAT.test(headerValue)) {
    return headerValue;
  }
  return randomUUID();
}
