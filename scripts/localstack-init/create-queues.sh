#!/bin/sh
set -eu

# Bloco 9a.3 (CHALLENGE.md secoes 4 e 10). Roda uma unica vez, no servico
# one-shot `localstack-init` do docker-compose.yml — nunca dentro do
# container `localstack` em si. Endereco explicito (nome do servico, nunca
# `localhost`): este container e uma maquina diferente da que roda o
# LocalStack, mesmo estando na mesma rede do Compose.

ENDPOINT="http://localstack:4566"
DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
MAX_RECEIVE_COUNT=5

aws_local() {
  aws --endpoint-url "$ENDPOINT" "$@"
}

# --- Atributos FIFO — justificativa (CHALLENGE.md secoes 3, 8 e 10) ---
#
# FifoQueue=true: exigido pelo proprio nome da fila (sufixo .fifo, secao 10)
# e pelas garantias de ordem que a secao 3 pede para o sistema tolerar bem.
# E uma OTIMIZACAO de entrega, nunca a garantia final — a secao 8 e
# explicita: "recursos de ordenacao e deduplicacao do broker sao
# otimizacao, nao a garantia final: o banco continua responsavel pelas
# invariantes."
#
# ContentBasedDeduplication=false (deliberado, nao omissao): deduplicar pelo
# hash do corpo da mensagem e conveniente, mas incidental — duas publicacoes
# do MESMO evento logico podem serializar de forma levemente diferente, e o
# SQS nao saberia que sao a "mesma" mensagem. Por isso os Blocos 9b/9c
# deverao publicar com um `MessageDeduplicationId` EXPLICITO e ESTAVEL,
# derivado da identidade ja persistida do evento (o id da OutboxMessage/
# mensagem), nunca de um hash incidental do payload — o mesmo principio que
# o resto do projeto ja segue (Idempotency-Key, messageId), nunca dedup
# implicito.
#
# RedrivePolicy com maxReceiveCount=5: limite provisorio de entregas antes
# de ir para a DLQ, aprovado como decisao PROVISORIA — o desenho real de
# retry/backoff do consumidor (Bloco 9b) e quem deve confirmar ou revisar
# este numero. Fica centralizado só aqui, na variavel MAX_RECEIVE_COUNT
# acima, para ser facil de encontrar e ajustar depois.

echo "Criando DLQ: $DLQ_NAME"
DLQ_URL=$(aws_local sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  --query 'QueueUrl' --output text)

DLQ_ARN=$(aws_local sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

echo "DLQ ARN: $DLQ_ARN"

# Um arquivo JSON temporario, dentro do proprio container, evita empilhar
# camadas de escape de aspas na linha de comando — mais legivel e mais facil
# de testar isoladamente do que uma string inline com JSON dentro de JSON.
ATTRIBUTES_FILE=$(mktemp)
cat > "$ATTRIBUTES_FILE" <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"$MAX_RECEIVE_COUNT\"}"
}
EOF

echo "Criando fila principal: $QUEUE_NAME"
aws_local sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "file://$ATTRIBUTES_FILE"

rm -f "$ATTRIBUTES_FILE"

echo "Filas prontas."
