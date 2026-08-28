# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) recebidas via HTTP e via uma fila SQS FIFO, com foco em correção financeira, idempotência persistente, concorrência entre múltiplas instâncias e recuperação após falhas. Os requisitos do desafio descrito em [`CHALLENGE.md`](./CHALLENGE.md).

As decisões de arquitetura, trade-offs e limitações conhecidas estão documentadas em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.4.x |
| Linguagem | TypeScript (modo estrito) |
| Framework | NestJS |
| Banco | PostgreSQL 16 |
| Mensageria | AWS SQS via LocalStack |
| ORM | MikroORM (`@mikro-orm/postgresql`) |
| Orquestração local | Docker Compose |

## Pré-requisitos

- [Bun](https://bun.sh) 1.4.x
- [Docker](https://www.docker.com/) e Docker Compose (para PostgreSQL e LocalStack)

Nenhuma outra dependência precisa estar instalada no host — Postgres e LocalStack rodam inteiramente em containers.

---

## Instalação

```bash
bun install
```

## Variáveis de ambiente

Copie o arquivo de exemplo e ajuste se necessário (os valores padrão já funcionam com o `docker-compose.yml` deste repositório):

```bash
cp .env.example .env
```

`.env` nunca é versionado (`.gitignore`); `.env.example` só contém valores fictícios/de desenvolvimento.

| Variável | Padrão | Uso |
|---|---|---|
| `POSTGRES_USER` | `app` | Postgres (Compose e aplicação) |
| `POSTGRES_PASSWORD` | `app` | Postgres (Compose e aplicação) |
| `POSTGRES_DB` | `jungle_gaming` | Postgres (Compose e aplicação) |
| `POSTGRES_HOST` | `localhost` | host do Postgres visto pela aplicação (que roda fora do Compose) |
| `POSTGRES_PORT` | `5432` | porta publicada pelo Compose |
| `LOCALSTACK_PORT` | `4566` | porta publicada pelo Compose |
| `AWS_REGION` | `us-east-1` | região fictícia usada contra o LocalStack |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | credenciais fictícias — o LocalStack não verifica assinatura |
| `SQS_ENDPOINT_URL` | `http://localhost:4566` | endpoint do LocalStack visto pela aplicação |
| `WAGER_TRANSACTIONS_CONSUMER_ENABLED` | `true` | liga o consumidor real de `wager-transactions.fifo` |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publisher real da Outbox |
| `PENDING_REFERENCE_WORKER_ENABLED` | não documentada no `.env.example`, mas lida por `main.ts` | liga o worker de reprocessamento de `PENDING_REFERENCE` |
| `PORT` | `3000` | porta HTTP da aplicação (`main.ts`) |

`src/main.ts` já liga os três workers acima (`??=`) quando a aplicação real sobe via `bun run start`; testes nunca setam essas variáveis (permanecem desligadas) a menos que o próprio teste precise delas.

---

## Subindo a infraestrutura

```bash
docker compose up -d
```

Isso sobe três serviços:

- **`postgres`** — Postgres 16, com healthcheck (`pg_isready`).
- **`localstack`** — LocalStack só com o serviço `sqs` ligado, com healthcheck que roda `awslocal sqs list-queues` dentro do próprio container.
- **`localstack-init`** — serviço *one-shot* (`scripts/localstack-init/create-queues.sh`) que espera o LocalStack ficar saudável e cria as 3 filas (ver [Filas SQS](#filas-sqs)), depois termina.

Para só o Postgres (sem LocalStack), existe o atalho `bun run db:up` — mas qualquer teste que use SQS (integração, concorrência, `test:concurrency:processes`) exige o `docker compose up -d` completo.

```bash
docker compose ps      # confirma os 3 serviços saudáveis/concluídos
docker compose down    # derruba tudo (mantém o volume postgres_data)
```

## Migrations

```bash
bun run migration:up     # aplica todas as migrations pendentes
bun run migration:down   # reverte a última migration
```

Todas as 6 migrations em `src/infra/database/migrations/` são reversíveis (`up`/`down`) e criam/alteram schema com constraints reais no banco (ver [`ARCHITECTURE.md`](./ARCHITECTURE.md#schema-postgresql-e-constraints)) — a garantia final de saldo não-negativo, unicidade e imutabilidade do ledger não depende só do código da aplicação.

```bash
bun run scripts/verify-database.ts   # também disponível como `bun run db:verify`
```
`db:verify` roda 14 tentativas reais de violar constraints do banco (saldo negativo, wallet duplicada, UPDATE/DELETE no ledger, etc.) e confirma que todas são rejeitadas — sem tocar em código de aplicação, só o schema.

---

## Rodando a aplicação

Com Postgres/LocalStack no ar e migrations aplicadas:

```bash
bun run start        # produção — bun run src/main.ts
bun run start:dev     # desenvolvimento — bun --watch src/main.ts
```

A aplicação escuta em `http://localhost:3000` (ou `$PORT`).

---

## Endpoints HTTP

Nenhum endpoint abaixo exige autenticação — ver [decisão registrada em `ARCHITECTURE.md`](./ARCHITECTURE.md#autenticação).

### Wallets

```http
POST /wallets
```
```json
{ "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }
```
Saldo inicial positivo gera uma transação interna `OPENING` e um lançamento `CREDIT` no ledger, na mesma transação SQL. `playerId` + `currency` duplicados retornam `409 Conflict`.

```http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50      # cursor opaco, keyset (created_at, id); limit entre 1 e 200 (padrão 50)
POST /wallets/:walletId/reconciliation
```
A reconciliação recalcula o saldo a partir do ledger inteiro (uma única query, mesma foto MVCC) e **nunca corrige** silenciosamente — só relata `consistent`, `difference` e loga/incrementa métrica quando há divergência.

### Wagering

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
```
```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```
O header `Idempotency-Key` é obrigatório. `kind` aceita `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (`OPENING` é interno, nunca aceito aqui). `REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId`.

Respostas possíveis: `201` (`PROCESSED`), `200` (replay idempotente de uma transação já `PROCESSED`), `202` (`PENDING_REFERENCE` — referência ainda não resolvida), `404` (wallet inexistente), `409` (conflito de idempotência ou de `providerId`+`externalTransactionId`), `422` (`REJECTED` por regra de negócio), `400` (payload inválido), `503` (contenção transitória de banco).

```http
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
```
Sempre `200` quando a linha existe — o status de negócio (`PROCESSED`/`REJECTED`/`PENDING_REFERENCE`/...) vai no corpo, nunca no status HTTP (diferente do `POST`, que usa o status HTTP para sinalizar o resultado do processamento).

### Health, métricas

```http
GET /health/live      # processo vivo — nunca consulta dependência nenhuma
GET /health/ready      # 200 só se Postgres e SQS responderem (timeout de 2s cada)
GET /metrics            # texto no formato de exposição do Prometheus
```

---

## Filas SQS

Criadas por `scripts/localstack-init/create-queues.sh` (parte do Docker Compose, não do código da aplicação):

| Fila | Tipo | Propósito |
|---|---|---|
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false` | fila de **entrada** — mensagens `WagerTransactionRequested` (CHALLENGE.md seção 10), consumidas por `WagerTransactionSqsConsumer` |
| `wager-transactions-dlq.fifo` | FIFO | destino de `wager-transactions.fifo` após `maxReceiveCount=5` falhas de entrega (RedrivePolicy) |
| `wager-transaction-events.fifo` | FIFO, `ContentBasedDeduplication=false` | fila de **saída** — eventos de integração publicados pelo worker da Outbox (nome não definido pelo desafio; decisão deste projeto). Sem DLQ própria: a tabela `outbox_messages` já é a fonte persistente de retry (uma linha só sai de "pendente" depois que a publicação e o commit terminam) |

Mensagem de entrada esperada em `wager-transactions.fifo` — ver exemplo completo em [`CHALLENGE.md` seção 10](./CHALLENGE.md#10-processamento-por-sqs).

---

## Scripts Bun

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação (produção) |
| `bun run start:dev` | sobe a aplicação com `--watch` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | suíte unitária — sem Postgres/LocalStack |
| `bun run test:integration` | suíte de integração — Postgres/LocalStack reais |
| `bun run test:concurrency` | suíte de concorrência "rápida" — Postgres/LocalStack reais, mas sem subir processos do SO |
| `bun run test:concurrency:processes` | suíte de concorrência com processos reais do SO (seção 13, itens 4 e 8) — mais lenta, roda separada |
| `bun run db:up` / `db:down` | sobe/derruba só o Postgres |
| `bun run db:verify` | roda `scripts/verify-database.ts` (checagem de constraints reais) |
| `bun run migration:up` / `migration:down` | aplica/reverte migrations |

---

## Testes

```bash
bun run typecheck
bun test                          # unidade — não precisa de Docker
docker compose up -d              # a partir daqui, todos precisam de Postgres + LocalStack no ar
bun run migration:up
bun run test:integration
bun run test:concurrency
bun run test:concurrency:processes
bun run db:verify
```

- **Unidade** (`bun test`, arquivos `*.spec.ts`): `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, Inbox/Outbox/eventos de domínio, hash de payload, cursor de paginação, backoff de retry, health (mocks) e métricas (registro idempotente) — sem PostgreSQL nem LocalStack.
- **Integração** (`bun run test:integration`, arquivos `*.integration.ts`): migrations e constraints, atomicidade entre wallet/ledger/inbox/outbox, consumidor SQS real, publisher da Outbox real (incluindo crash simulado + retomada), `/health`, `/metrics` — tudo contra Postgres e LocalStack reais em container.
- **Concorrência** (`bun run test:concurrency`, arquivos `*.concurrency.ts`): paralelismo real (nunca mocks sequenciais) — 50 réplicas da mesma aposta, disputa de saldo (cenário obrigatório da seção 8), wallets distintas em paralelo, duas instâncias reais do consumidor SQS e do publisher da Outbox concorrendo. Roda em segundos.
- **Concorrência com processos reais** (`bun run test:concurrency:processes`, arquivos `multi-instance-processes.concurrency.ts` e `service-restart.concurrency.ts`): sobe `bun run src/main.ts` como processo real do SO (via `Bun.spawn`) para provar literalmente os dois cenários da seção 13 que exigem múltiplos processos/instâncias e reinício real — não roda no dia a dia por ser mais lento (múltiplos boots completos da aplicação); rode antes de qualquer entrega ou ao mexer nessa área.
- **`db:verify`**: 14 tentativas de violar constraints reais do Postgres — não é um teste de aplicação, é uma prova de que as invariantes estão no schema, não só no código.

Invariante final verificada em toda a suíte: `wallet.balance == saldo reconstruído pelo ledger`.

---

## Como reproduzir os cenários principais

Todos os exemplos abaixo assumem `docker compose up -d`, migrations aplicadas e `bun run start` rodando em `http://localhost:3000`.

### 1. Cenário obrigatório da seção 8 — duas apostas de 80 sobre saldo 100

```bash
# cria a wallet
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"<uuid-do-player>","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# duas apostas de 80.00 disparadas ao mesmo tempo (dois terminais, ou em paralelo)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:bet-a' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-a","playerId":"<uuid>","walletId":"<uuid>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}' &
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:bet-b' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-b","playerId":"<uuid>","walletId":"<uuid>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```
Resultado esperado: uma resposta `201 PROCESSED`, a outra `422 REJECTED` (`INSUFFICIENT_FUNDS`), saldo final `20.00`. Provado automaticamente em `src/wagering/process-bet.concurrency.ts` e, com processos reais do SO, em `src/wagering/multi-instance-processes.concurrency.ts`.

### 2. Idempotência — replay com o mesmo `Idempotency-Key`

Repita exatamente a mesma requisição `POST /wagering/transactions` com o mesmo header `idempotency-key` e o mesmo corpo: a resposta é a mesma (`idempotentReplay: true`), sem novo débito. Envie o mesmo header com um corpo diferente: `409 Conflict`. Provado em `src/wagering/idempotency.concurrency.ts` (50 réplicas em paralelo → um único débito) e `src/wagering/wagering.integration.ts`.

### 3. Referência fora de ordem — `REFUND` antes da `BET`

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:refund-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"refund-1","playerId":"<uuid>","walletId":"<uuid>","roundId":"round-1","gameId":"fortune-chimp","kind":"REFUND","money":{"amount":"30.00","currency":"BRL"},"referenceExternalTransactionId":"bet-ainda-nao-existe"}'
# -> 202 PENDING_REFERENCE

# alguns segundos depois, envie a BET referenciada com o mesmo valor (30.00) e roundId/gameId
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:bet-ainda-nao-existe' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-ainda-nao-existe","playerId":"<uuid>","walletId":"<uuid>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"30.00","currency":"BRL"}}'
```
O worker de `PENDING_REFERENCE` (tick a cada 3s) resolve o `REFUND` sozinho assim que a `BET` existir — confirme via `GET /wagering/transactions/:transactionId` (status muda para `PROCESSED`). Provado em `src/wagering/retry-pending-reference.concurrency.ts` e `retry-pending-reference.integration.ts`.

### 4. Concorrência real com ≥ 3 processos/instâncias

```bash
bun run test:concurrency:processes
```
Sobe 3 processos reais do SO (`bun run src/main.ts`, portas 3301–3303) disputando mensagens reais de `wager-transactions.fifo` e servindo HTTP simultaneamente (incluindo o cenário da seção 8 disparado por dois processos diferentes). Ver `src/wagering/multi-instance-processes.concurrency.ts`.

### 5. Reinício do serviço com consistência final

Mesmo comando acima executa também `src/wagering/service-restart.concurrency.ts`: mata um processo real com `SIGKILL` depois de commitar trabalho ainda não publicado/resolvido, sobe um processo novo e prova que os 3 eventos pendentes são publicados, o `REFUND` é resolvido e `wallet.balance` continua igual ao saldo reconstruído pelo ledger.

### 6. Reconciliação

```bash
curl -s -X POST http://localhost:3000/wallets/<uuid>/reconciliation
```

### 7. Métricas e health

```bash
curl -s http://localhost:3000/metrics
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready
```

---

## Observabilidade

Logs estruturados (JSON), métricas Prometheus e health checks separados (liveness/readiness), detalhes de cada métrica, o que cada log carrega (e o que nunca carrega) estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md#observabilidade).

## Autenticação

Não implementada nesta entrega, decisão registrada e justificada em [`ARCHITECTURE.md`](./ARCHITECTURE.md#autenticação). Os endpoints de health ficam abertos por design, conforme a seção 2 do desafio.

## Estrutura de pastas

```
src/
  domain/            # Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos — sem NestJS/ORM
  infra/database/     # entities MikroORM + migrations
  wallets/            # HTTP + casos de uso de wallet (abrir, consultar, ledger, reconciliação)
  wagering/           # HTTP + provider API + caso de uso de submissão + consumidor SQS + worker de PENDING_REFERENCE
  messaging/           # Inbox/Outbox (SQL) + publisher da Outbox
  health/             # /health/live, /health/ready
  metrics/            # /metrics
  observability/      # métricas Prometheus, logs estruturados, correlationId
scripts/
  localstack-init/     # criação das filas SQS (Docker Compose)
  verify-database.ts   # checagem de constraints reais (db:verify)
```
