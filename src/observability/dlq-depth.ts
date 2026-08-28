import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { resolveQueueUrl } from '../wagering/sqs-client';

/**
 * Nome fixo da DLQ (CHALLENGE.md secao 10 / scripts/localstack-init/create-queues.sh)
 * — usado so para leitura de atributos aqui, nunca para consumir/apagar
 * mensagens. Este arquivo nunca toca o consumidor real.
 */
export const WAGER_TRANSACTIONS_DLQ_QUEUE_NAME = 'wager-transactions-dlq.fifo';

export interface DlqDepth {
  visible: number;
  inFlight: number;
}

/** Profundidade real da DLQ via GetQueueAttributes — nunca ReceiveMessage (isso consumiria a mensagem). */
export async function selectDlqDepth(client: SQSClient): Promise<DlqDepth> {
  const queueUrl = await resolveQueueUrl(client, WAGER_TRANSACTIONS_DLQ_QUEUE_NAME);
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? '0'),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0'),
  };
}
