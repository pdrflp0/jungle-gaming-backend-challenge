import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

/**
 * Nome fixo pelo desafio (CHALLENGE.md secao 10) — precisa bater exatamente
 * com o `QUEUE_NAME` de scripts/localstack-init/create-queues.sh (Bloco
 * 9a.3). Nao vira variavel de ambiente: nao existe cenario em que faca
 * sentido apontar para uma fila com outro nome.
 */
export const WAGER_TRANSACTIONS_QUEUE_NAME = 'wager-transactions.fifo';

/**
 * Regiao e credenciais ficticias — validas so contra o LocalStack, que nao
 * verifica assinatura real. `SQS_ENDPOINT_URL` e o unico ponto que muda
 * entre "app rodando no host" (`http://localhost:4566`, default) e "app
 * rodando dentro do Compose" (`http://localstack:4566`, ainda nao o caso
 * neste bloco) — nenhuma outra linha de codigo muda entre os dois cenarios.
 */
export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

/** Descoberta da QueueUrl — nunca uma URL codificada no codigo. */
export async function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) {
    throw new Error(`SQS did not return a QueueUrl for queue name "${queueName}"`);
  }
  return QueueUrl;
}
