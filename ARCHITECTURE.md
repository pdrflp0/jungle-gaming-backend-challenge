# ARCHITECTURE.md

Decisões de arquitetura, trade-offs e limitações conhecidas do Distributed Wagering Processor. `CHALLENGE.md` é a fonte de verdade sobre os requisitos; este documento explica **como** e **por quê** cada um foi atendido, e o que ainda não foi provado.

---

## Visão geral

Provedores de jogos enviam operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) associadas a uma rodada, via HTTP síncrono ou via uma fila SQS FIFO assíncrona. A entrega é *at-least-once* em ambos os canais (o cliente HTTP pode reenviar por timeout; o SQS pode reentregar por visibility timeout). O sistema garante:

- nenhum crédito ou débito duplicado, mesmo sob reenvio, redelivery ou concorrência real;
- saldo nunca negativo;
- toda alteração de saldo tem exatamente um lançamento correspondente no ledger, e vice-versa;
- eventos de integração só são publicados depois do commit da transação financeira que os originou, e uma publicação duplicada é seguramente absorvida pelo lado que consome;
- o sistema funciona corretamente com múltiplas instâncias da aplicação rodando ao mesmo tempo — a garantia final de qualquer invariante está no PostgreSQL (constraints, locks, transações), nunca em memória de um único processo.

## Stack e por que MikroORM

MikroORM (`@mikro-orm/postgresql`) foi escolhido, entre as duas opções aceitas pelo desafio, por três motivos concretos usados neste projeto:

1. **`EntityManager.transactional()` explícito** — toda escrita financeira roda dentro de um callback transacional único, nunca espalhada em múltiplos `save()` implícitos.
2. **SQL cru controlado quando o Unit of Work atrapalharia** — o fluxo de submissão de transação (`submit-wager-transaction.use-case.ts`) precisa tentar um `INSERT` que pode falhar por violação de `UNIQUE` **dentro de um `SAVEPOINT`**, para decidir entre "sou eu quem ganhou a corrida" e "outra requisição chegou primeiro com a mesma idempotency key". Se essas linhas fossem entidades gerenciadas pelo MikroORM, elas ficariam presas no Unit of Work esperando um flush que nunca viria do jeito certo depois de um rollback de savepoint. Por isso todo esse fluxo usa `em.getConnection().execute()` com `em.getTransactionContext()` explícito (ver `wager-transaction.sql.ts`, `wallet.sql.ts`, `outbox.sql.ts`, `inbox.sql.ts`) — SQL parametrizado, nunca concatenado, mas sem `persist()`/`flush()` no caminho crítico.
3. **`orm.em.fork()`** — cada teste de concorrência real (duas "instâncias" de consumidor SQS ou de publisher da Outbox competindo pela mesma linha) precisa de um `EntityManager` independente por instância, sem compartilhar Unit of Work nem conexão — exatamente o que `fork()` garante.

Os poucos pontos que usam entidades MikroORM "normais" (`wallet.entity.ts`, `wager-transaction.entity.ts`, `wallet-ledger-entry.entity.ts`, `inbox-message.entity.ts`, `outbox-message.entity.ts`) existem só para o mapeamento de schema (`mikro-orm.config.ts`) e para os dois `INSERT` iniciais de `open-wallet.use-case.ts` (que não competem por nenhuma constraint de corrida) — não para o fluxo de submissão de transação, que é 100% SQL cru dentro da transação aberta.

O mapeamento de `Money` nunca usa tipo monetário do ORM: persistência é sempre `NUMERIC(19,2)` (duas colunas: `amount`/`currency` ou `balance_amount`/`currency`, dependendo da tabela), lido como `string` e reidratado via `Money.from(...)` — nunca `number`.

---

## Modelo de domínio

Todo o domínio (`src/domain/`) é independente de NestJS e do ORM: construtores privados, factories estáticas (`create`/`from`/`zero`/`open`/`rehydrate`), sem decorator nenhum.

### `Money` (`src/domain/money/money.ts`)

Envolve `Decimal` (biblioteca `decimal.js`) — nunca `number`/`float`/`double`. `amount` só é aceito como string casando `^\d+(\.\d{1,2})?$` (sem sinal, sem notação científica, no máximo 2 casas); `currency` como `^[A-Z]{3}$`. Toda operação (`add`, `subtract`, `negate`) devolve uma nova instância; operar entre moedas diferentes lança `CurrencyMismatchError`. Um teto (`99999999999999999.99`, alinhado a `NUMERIC(19,2)`) é verificado no único ponto de construção interno (`Money.of`), então nenhuma soma pode silenciosamente estourar a coluna do banco. Serialização (`toJSON()`) sempre devolve `amount` com `toFixed(2)` — nunca notação variável.

O desafio permite reduzir escopo assumindo uma única moeda (`BRL`) mantendo o modelo multi-moeda — é o que este projeto faz: todos os testes/exemplos usam `BRL`, mas `Money`/`Wallet` nunca assumem uma moeda fixa em código, e o conflito de moeda é testado (`money.spec.ts`, `wallet.spec.ts`, e o `failureCode CURRENCY_MISMATCH` end-to-end).

### `Wallet` (`src/domain/wallet/wallet.ts`)

Aggregate root: `id`, `playerId`, `currency`, saldo e `version` privados com getters. `debit`/`credit` validam moeda e valor estritamente positivo, calculam o novo saldo, criam o `WalletLedgerEntry` correspondente **na mesma chamada** (nunca em dois passos separados que poderiam divergir) e incrementam `version` — só quando o saldo de fato muda. `debit` rejeita saldo negativo lançando `InsufficientFundsError` **antes** de mutar qualquer estado interno. `Wallet.open` cria a wallet e, se o saldo inicial for positivo, também o lançamento `CREDIT` de abertura — exigindo os dois dados (`transactionId`, `entryId`) para não deixar a wallet "aberta" sem o rastro contábil correspondente.

### `WagerTransaction` (`src/domain/wagering/wager-transaction.ts`)

Máquina de estados com transições explícitas (`markProcessed`, `markPendingReference`, `reject`, `fail`) que lançam `InvalidTransactionStateError` se o estado atual já for terminal (`PROCESSED`/`REJECTED`/`FAILED`). `OPENING` só nasce via `createOpening` (nunca `create`, que lança `OpeningIsInternalError` se tentado) — não é aceitável pela API nem pela fila. `ledgerDirectionFor(reference?)` centraliza a regra de direção por `kind` e, para `WIN`/`REFUND`/`ROLLBACK`, a validação da referência (`assertValidReference`): mesmo `externalTransactionId` esperado, status `PROCESSED`, mesmo `providerId`/`playerId`/`walletId`/`roundId`/moeda, e (exceto para `WIN`) mesmo valor exato — reversão parcial está fora de escopo, conforme o desafio permite.

`FailureCode` é a taxonomia deste projeto (seção 7.2 do desafio, que deixa a decisão livre): `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_ALREADY_REVERSED`, `REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE` (distinto de `INSUFFICIENT_FUNDS` — uma reversão que zeraria o saldo abaixo de zero é operacionalmente diferente de uma aposta sem saldo, exatamente como a seção 7.9 pede), `INVALID_REFERENCE`, `BALANCE_LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### `WalletLedgerEntry` (`src/domain/wallet/wallet-ledger-entry.ts`)

Sem campo mutável, sem método de transição — a imutabilidade é estrutural. `create()` valida `balanceBefore ± money === balanceAfter` (`isBalanced()`) antes de existir; nunca é possível construir um lançamento cuja aritmética não bate. `LOSS` e qualquer transação `REJECTED` nunca chegam a chamar `Wallet.debit`/`credit`, então nunca geram lançamento — não é uma checagem extra, é a ausência da chamada.

### Inbox / Outbox (`src/domain/messaging/`)

`InboxMessage` e `OutboxMessage` seguem o mesmo padrão factory/rehydrate. Na prática, o caminho de escrita usa SQL cru (`messaging/inbox.sql.ts`, `messaging/outbox.sql.ts`) pelo mesmo motivo do fluxo financeiro (Unit of Work atrapalharia um `INSERT ... ON CONFLICT DO NOTHING` dentro de uma transação em andamento) — as classes de domínio documentam o contrato e são cobertas por testes unitários próprios (`inbox-message.spec.ts`, `outbox-message.spec.ts`, `outbox-retry-backoff.spec.ts`).

---

## Schema PostgreSQL e constraints

O desafio exige (seção 5.9) que unicidade, imutabilidade e não-negatividade estejam **no schema**, não só na aplicação. As 6 migrations em `src/infra/database/migrations/` (todas com `up`/`down`) fazem exatamente isso:

- **`wallets`**: `CHECK (balance_amount >= 0)`, `CHECK (version >= 1)`, `UNIQUE (player_id, currency)` (no máximo uma wallet por jogador+moeda), `UNIQUE (id, currency)` (usada por uma FK composta que depois foi relaxada — ver abaixo).
- **`wager_transactions`**: `CHECK (amount > 0)`, `CHECK (kind IN (...))`, `CHECK (status IN (...))`, `UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)`, um índice único **parcial** `(reference_transaction_id, kind) WHERE reference_transaction_id IS NOT NULL AND kind IN ('REFUND','ROLLBACK')` — impede no banco que a mesma referência seja revertida duas vezes pelo mesmo tipo de operação, mesmo sob corrida. `CHECK` cruzados garantem consistência entre colunas: `processed_at` só existe quando `status = 'PROCESSED'`; `failure_code` só existe quando `status IN ('REJECTED','FAILED')`; `result_balance_amount`/`result_balance_currency` sempre juntos ou nenhum; `next_attempt_at` só existe quando `status = 'PENDING_REFERENCE'` (`wager_transactions_next_attempt_consistency`, migration `20260828000000`).
- **`wallet_ledger_entries`**: `CHECK (amount > 0)`, `CHECK (direction IN ('DEBIT','CREDIT'))`, `CHECK (balance_before >= 0)`, `CHECK (balance_after >= 0)`, e a aritmética em si — `CHECK ((direction='CREDIT' AND balance_after = balance_before + amount) OR (direction='DEBIT' AND balance_after = balance_before - amount))` — validada duas vezes, uma no domínio (`WalletLedgerEntry.isBalanced()`) e uma no banco, porque o desafio pede a garantia final no schema. **Imutabilidade**: um trigger `BEFORE UPDATE OR DELETE` (`prevent_ledger_mutation()`) levanta exceção para qualquer tentativa de `UPDATE`/`DELETE` — não é uma convenção de código, é impossível de violar mesmo com acesso direto ao banco. `UNIQUE (wallet_id, transaction_id)`: no máximo um lançamento por transação por wallet.
- **`inbox_messages`**: chave primária composta `(consumer_name, message_id)` — a garantia de deduplicação do consumidor SQS é essa PK, não um cache em memória.
- **`outbox_messages`**: `CHECK (attempts >= 0)`, `CHECK ((published_at IS NULL AND next_attempt_at IS NOT NULL) OR (published_at IS NOT NULL AND next_attempt_at IS NULL))`.

A FK composta original entre `wager_transactions (wallet_id, currency)` e `wallets (id, currency)` foi relaxada para uma FK simples (`wager_transactions_wallet_fk`, migration `20260827010000`) depois de descobrir, implementando o processamento real de `BET`, que rejeitar graciosamente uma moeda divergente (com `failureCode CURRENCY_MISMATCH`) exige conseguir **inserir** a transação com a moeda realmente submetida — que por definição diverge da wallet nesse caso. O ledger manteve a FK composta original: um lançamento real de dinheiro sempre bate com a moeda da wallet, essa garantia não relaxou.

Dois índices parciais existem especificamente para os workers de reprocessamento: `wager_transactions_pending_reference_due_idx` (`WHERE status = 'PENDING_REFERENCE'`, ordenado por `next_attempt_at`) e `outbox_messages_pending_due_idx` (`WHERE published_at IS NULL`) — ambos existem para que `SELECT ... FOR UPDATE SKIP LOCKED` encontre "o que está devido agora" sem varrer a tabela inteira.

---

## Transações e atomicidade

O desafio (seção 6.5 e 11) exige que persistência da transação, alteração de saldo, lançamento no ledger, registro de Inbox (quando a entrada é SQS) e evento de integração sejam atômicos — tudo confirmado junto, ou nada. Isso é literal neste projeto: **exatamente uma** chamada a `em.transactional(...)` por operação de negócio, contendo todos esses passos:

- `OpenWalletUseCase.execute` — insere a wallet, a `WagerTransaction` `OPENING` (se saldo positivo), o lançamento `CREDIT`, e os dois eventos (`WagerTransactionProcessed` + `WalletBalanceChanged`) na Outbox.
- `SubmitWagerTransactionUseCase.execute` (HTTP) e `processWagerTransactionMessage` (SQS, chamado **dentro** da mesma `em.transactional()` aberta pelo consumidor) — travam a wallet, decidem o resultado, atualizam saldo/ledger/status, e inserem o(s) evento(s) correspondente(s) na Outbox. No caminho SQS, o registro do Inbox também está dentro dessa mesma transação.
- `RetryPendingReferenceWorker.processDueOnce` — mesma disciplina: uma transação curta por linha `PENDING_REFERENCE` resolvida.

Dentro dessas transações, um `SAVEPOINT` (`createSavepoint`/`rollbackToSavepoint` em `wager-transaction.sql.ts`) isola só o `INSERT` que pode falhar por `UNIQUE (idempotency_key)` ou `UNIQUE (provider_id, external_transaction_id)` — se falhar, um `ROLLBACK TO SAVEPOINT` desfaz só esse `INSERT`, sem abortar a transação inteira, e o código relê a linha vencedora para devolver o resultado correto (replay ou conflito). Transações são deliberadamente **curtas**: nenhum fluxo mantém a wallet travada por mais que os passos estritamente necessários, e nenhuma trava mais de uma wallet ao mesmo tempo (ver [Concorrência](#concorrência)).

Publicação de evento **nunca** acontece antes do commit: a Outbox só registra a *intenção* de publicar (`insertOutboxMessage`, na mesma transação); a publicação real para o SQS acontece depois, por um worker separado, lendo uma linha já commitada (ver [Outbox](#outbox)).

---

## Idempotência

- O header `Idempotency-Key` é obrigatório em `POST /wagering/transactions` e é a fonte da verdade — `UNIQUE (idempotency_key)` no banco é a garantia final, não uma checagem prévia em memória.
- `payloadHash` (`wagering/payload-hash.ts`) é SHA-256 de um **JSON canônico**: chaves ordenadas alfabeticamente, recursivamente, calculado só sobre os campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId` quando presente) — nunca o header de transporte, nunca metadados de chegada.
- Replay (mesma key, mesmo hash) devolve a resposta original, incluindo o saldo observado naquele momento (`idempotentReplay: true`) — nunca reprocessa. Mesma key, hash diferente → `409 Conflict` explícito, nunca tratado como replay.
- A corrida real (duas requisições com a mesma key chegando ao mesmo tempo, em processos diferentes) é resolvida pelo `SAVEPOINT` descrito acima: o `INSERT` que viola `UNIQUE (idempotency_key)` é o árbitro, não uma leitura prévia (que é só uma otimização para o caminho feliz — pular direto para o replay sem abrir transação nem travar a wallet quando a key já existe de forma óbvia).
- No consumidor SQS, a mesma garantia existe em uma segunda camada: o **Inbox** deduplica por `(consumerName, messageId)` — a chave primária composta é o árbitro para *duplicação de transporte* (mesma entrega reenviada pelo SQS), enquanto a `idempotency_key` (embutida em `data.idempotencyKey` no envelope da fila) é o árbitro para *duplicação de negócio*. As duas existem porque resolvem problemas diferentes: o Inbox nunca reprocessaria uma mensagem já commitada mesmo que ela tivesse, por algum bug, uma `idempotencyKey` diferente a cada reenvio; a `idempotency_key` nunca deixaria passar duas mensagens de negócio idênticas vindas por dois `messageId` de transporte diferentes.
- Idempotência é **persistente** em ambas as camadas — nunca um `Map`/cache em memória de processo.

---

## Concorrência

A unidade de concorrência é a `walletId` (seção 8 do desafio). Estratégia escolhida: **pessimistic locking** via `SELECT ... FOR UPDATE` sobre a linha da wallet (`selectWalletForUpdate`), sempre como o **primeiro** passo dentro da transação, antes de qualquer decisão de negócio. Foi preferida a optimistic locking com retry porque:

- o campo `version` já existe e é mantido corretamente (incrementa só quando o saldo muda), mas retry de aplicação sob alta contenção em uma única wallet ("hot wallet") tende a degradar em vez de serializar — o lock pessimista serializa exatamente as transações que tocam a mesma wallet, sem afetar wallets diferentes;
- nunca é um lock global: cada transação trava **no máximo uma linha de `wallets`** — a prova disso está em `submit-wager-transaction-lock-conflict.spec.ts` e no comentário histórico em `wager-transaction-sqs-consumer.integration.ts` (nenhum fluxo deste projeto trava duas wallets na mesma transação, então um deadlock genuíno entre duas wallets é estruturalmente impossível de reproduzir aqui — ver [Limitações](#limitações-conhecidas)).

Ordenação e deduplicação nativas do SQS FIFO (`MessageGroupId` por wallet, `ContentBasedDeduplication` desligado a favor de `MessageDeduplicationId` explícito) são tratadas como **otimização de entrega**, nunca como a garantia final — a seção 8 do desafio é explícita nisso, e a prova disso é que o Inbox e o lock pessimista continuam sendo os únicos árbitros reais mesmo quando o SQS falha em preservar ordem ou deduplicar.

### Cenário obrigatório (seção 8)

Saldo `100.00`, duas apostas de `80.00` simultâneas → exatamente uma `PROCESSED`, a outra `REJECTED` (`INSUFFICIENT_FUNDS`), saldo final `20.00`, um único lançamento `DEBIT`. Provado em 3 camadas progressivamente mais realistas:

1. `process-bet.concurrency.ts` — duas requisições HTTP reais (`Promise.all`, sem `await` entre elas) contra uma única instância Nest em processo.
2. `wager-transaction-sqs-consumer.concurrency.ts` — duas instâncias do consumidor SQS, cada uma com seu próprio `EntityManager` (`orm.em.fork()`) e `SQSClient`, competindo pela fila real; `outbox-publisher.concurrency.ts` — o mesmo padrão para dois publishers da Outbox.
3. `multi-instance-processes.concurrency.ts` — **3 processos reais do sistema operacional** (`Bun.spawn`, não objetos dentro do mesmo processo), portas fixas, cada um a aplicação Nest inteira, dois deles disputando a mesma wallet via HTTP e o terceiro atendendo uma wallet diferente ao mesmo tempo (prova de isolamento entre wallets através de processos de verdade, não só de objetos).

A camada 3 é a que fecha literalmente o item 4 da seção 13 (**≥ 3 processos/instâncias simultâneos**) — as camadas 1 e 2 já provam ausência de *race* real (Postgres, transações, locks reais), mas nunca cruzam um limite de processo do SO.

---

## Referências fora de ordem — `PENDING_REFERENCE`

`REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId`; se a referência ainda não existir (ou existir mas ainda estiver ela mesma `PENDING_REFERENCE`), a transação nasce/permanece `PENDING_REFERENCE` (nunca rejeitada de imediato) e um evento `WagerTransactionPendingReference` é publicado. `RetryPendingReferenceWorker` (`@Interval` a cada **3s**, `wagering/retry-worker.config.ts`) reprocessa: `SELECT ... FOR UPDATE SKIP LOCKED` pega até 25 linhas devidas por tick, uma transação curta por linha (nunca mais de uma wallet travada por vez). Backoff exponencial próprio: 5s, 10s, 20s, 40s, 80s, 160s, teto de 300s. TTL de **30 minutos** desde a criação (`created_at`, calculado pelo próprio Postgres, nunca pelo relógio da aplicação): esgotado, a transação vira `REJECTED` com `failureCode REFERENCE_NOT_FOUND` e o evento terminal correspondente é publicado. Esses três números (tick, backoff, TTL) são decisão deste projeto, documentados aqui porque o desafio deixa a escolha livre.

O mesmo backoff exponencial (base/teto iguais, mas implementação **deliberadamente separada** — `domain/messaging/outbox-retry-backoff.ts`) existe para o publisher da Outbox; a decisão vinculante foi não extrair uma abstração compartilhada só por semelhança matemática entre dois problemas com causas diferentes (referência ausente vs. falha de publicação).

---

## Inbox

`WagerTransactionSqsConsumer` (`wagering/wager-transaction-sqs-consumer.ts`) faz *long-poll* (`WaitTimeSeconds=20` em produção) em `wager-transactions.fifo`, uma mensagem por vez. Cada mensagem roda em sua própria transação (`em.transactional`), chamando `processWagerTransactionMessage` (`process-wager-transaction-message.ts`) — que reutiliza **o mesmo** `SubmitWagerTransactionUseCase` do caminho HTTP, sem nenhuma cópia de regra de negócio.

Fluxo de deduplicação: `INSERT INTO inbox_messages ... ON CONFLICT (consumer_name, message_id) DO NOTHING RETURNING *`. Se a linha voltar, esta execução é a dona e prossegue. Se não voltar, a mensagem já foi vista antes (ou está sendo vista concorrentemente agora) — o código relê a linha existente e classifica em 3 casos, nunca tratando ambiguidade como sucesso silencioso:

- `payload_hash` diferente → `ConflictingInboxPayloadError` (mensagem "veneno": mesmo `messageId`, corpo diferente) — nunca tratada como duplicata segura;
- `processed_at IS NULL` → `InconsistentInboxStateError` — estado que não deveria ser alcançável (Inbox e processamento financeiro sempre commitam juntos), tratado como anomalia, nunca como sucesso;
- caso normal (`payload_hash` igual, `processed_at` preenchido) → `inboxDuplicatesDetectedTotal.inc()` e `'duplicate'`, mensagem apagada da fila sem reprocessar nada.

`ack` (`DeleteMessage`) só acontece **depois** do commit da transação — nunca antes. Erros são classificados explicitamente: rejeição de negócio (`UnprocessableEntityException` do caso de uso — a transação já commitou um `REJECTED` válido e auditável dentro do próprio savepoint) conta como `'processed'` e a mensagem é apagada; qualquer outra exceção propaga, a mensagem **nunca** é apagada, e o SQS cuida da reentrega (visibility timeout) e, depois de `maxReceiveCount=5`, da DLQ (`RedrivePolicy`, configurada em `create-queues.sh`) — nenhum retry em memória no código da aplicação.

Em `SIGTERM` (`onApplicationShutdown`), o consumidor para de iniciar novos `ReceiveMessage` e espera a iteração em andamento terminar sozinha antes de fechar o `SQSClient` — deliberadamente **não** cancela um long-poll já em andamento (não existe forma segura de fazer isso sem risco de perder uma mensagem que o SQS já tenha selecionado no instante do cancelamento); o pior caso é esperar até `WaitTimeSeconds` por um poll vazio, aceito como trade-off.

---

## Outbox

Toda escrita financeira que produz um evento insere uma linha em `outbox_messages` **na mesma transação SQL** (nunca depois). `OutboxPublisherWorker` (`messaging/outbox-publisher.worker.ts`) roda um loop contínuo (poll de 1s quando ocioso) chamando `publishDueOutboxMessage` (`messaging/outbox-publisher.ts`): `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` reivindica uma linha devida, tenta `SendMessage` para `wager-transaction-events.fifo` com `MessageDeduplicationId` **estável** (o próprio `id` da `OutboxMessage`, nunca um hash incidental do payload) e `MessageGroupId` = `walletId` (extraído de `payload.data.walletId`, presente nos 4 tipos de evento). Sucesso → `published_at = now()`. Falha → log estruturado sanitizado, `attempts += 1`, `next_attempt_at` recalculado pelo backoff, métrica `outbox_publish_retries_total` incrementada — a linha nunca desaparece até publicar de verdade.

Múltiplos publishers concorrentes (seção 11) são seguros porque `FOR UPDATE SKIP LOCKED` nunca deixa dois publishers reivindicarem a mesma linha — provado com 2 publishers em processo (`outbox-publisher.concurrency.ts`, 10 linhas disputadas, `countA + countB === 10`) e, para o cenário completo de crash + retomada por outro processo, em `service-restart.concurrency.ts` (ver abaixo).

Cenário do desafio ("o Postgres confirma o commit; o processo morre antes de publicar; outra instância assume o trabalho; o evento é publicado; uma publicação duplicada continua segura") é provado em duas camadas: `outbox-publisher.integration.ts` simula a morte via rollback forçado + um objeto novo retomando dentro do mesmo processo de teste; `service-restart.concurrency.ts` mata um **processo real do SO** com `SIGKILL` depois de commitar 3 eventos ainda não drenados, sobe um processo novo com o publisher e o worker de `PENDING_REFERENCE` ligados, e confirma que os 3 sobrevivem e são publicados, mais 4 novos gerados pela retomada — 7 eventos publicados no total, cada um inspecionado individualmente na fila real (nunca só uma contagem aproximada via `GetQueueAttributes`), sem duplicação indevida. "Publicação duplicada continua segura para o consumidor" é a responsabilidade do lado que consome — este projeto não tem um consumidor real de `wager-transaction-events.fifo` (fora de escopo), mas o `MessageDeduplicationId` estável é exatamente o mecanismo que tornaria isso possível, e o padrão Inbox já provado do lado de entrada é a mesma técnica que um consumidor desses usaria.

### Eventos mínimos

| Evento | Quando | Onde é emitido |
|---|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada (inclusive `LOSS` e `OPENING`) | `open-wallet.use-case.ts`, `submit-wager-transaction.use-case.ts`, `resolve-wager-reference.ts` |
| `WagerTransactionRejected` | rejeição por regra de negócio | `submit-wager-transaction.use-case.ts`, `resolve-wager-reference.ts`, `retry-pending-reference.worker.ts` (TTL esgotado) |
| `WalletBalanceChanged` | somente quando o saldo muda | mesmos 3 pontos acima, exceto `LOSS` (nunca muda saldo) |
| `WagerTransactionPendingReference` | referência ausente | `submit-wager-transaction.use-case.ts` |

Envelope (`domain/messaging/integration-event.ts`): classe abstrata `IntegrationEvent<T>`, uma subclasse concreta por evento (`domain/messaging/wagering-events.ts`) com `eventType`/`version` **no tipo**, nunca uma string solta no call site. `data` sempre carrega `MoneyProps` (string), nunca a instância de `Money`.

---

## Observabilidade

### Logs

`logStructuredWarning` (`observability/structured-logger.ts`) — JSON via `console.warn`, ponto de entrada único (troca de implementação, por exemplo para Pino, não exigiria mudar nenhum call site). Cada log carrega só o suficiente para localizar e correlacionar (`correlationId`, `walletId`, contadores) — nunca saldo, diferença calculada, payload financeiro completo ou dado pessoal.

`correlationId` (`observability/correlation-id.ts`): usa o header `X-Correlation-Id` se vier num formato simples (`^[A-Za-z0-9_.:-]{1,100}$`), senão gera um novo — nunca rejeita a requisição por causa de um valor de correlação inválido, só ignora e gera outro. No caminho SQS, o `correlationId` é o `messageId` do **envelope de negócio** do desafio, nunca o `MessageId` de transporte que o SQS devolve (que pertence só à camada de transporte).

### Métricas (`GET /metrics`, formato de exposição do Prometheus)

Registry próprio (`observability/metrics.ts`, nunca o registro global do `prom-client`) — evita erro de "métrica já registrada" quando `NestFactory.create(AppModule)` roda várias vezes no mesmo processo (testes de integração).

| Métrica | Tipo | Cobre o requisito de... |
|---|---|---|
| `wager_transactions_by_status{kind,status}` | Gauge, recalculada a cada scrape (`.reset()` antes de repovoar) | transações por status |
| `inbox_duplicates_detected_total` | Counter | duplicatas detectadas |
| `wager_pending_reference_retries_total{kind}` | Counter | retries |
| `outbox_publish_retries_total{event_type}` | Counter | retries |
| `wager_transactions_dlq_messages{visibility}` | Gauge, via `GetQueueAttributes` real (nunca um contador da aplicação) | mensagens em DLQ |
| `wager_lock_conflicts_total{type}` | Counter, incrementada só nos catches reais de `DeadlockException`/`LockWaitTimeoutException` | conflitos de lock |
| `outbox_lag_seconds` | Gauge, `extract(epoch FROM now() - occurred_at)` da linha pendente mais antiga, calculado pelo Postgres | outbox lag |
| `wager_transaction_processing_duration_seconds{source,outcome}` | Histogram, medido em `finally` (sucesso ou erro) tanto no HTTP quanto no consumidor SQS | latência de processamento |
| `wallet_reconciliation_divergences_total{currency}` | Counter | (adicional deste projeto — divergência de reconciliação) |

As 3 gauges "de estado atual" são recalculadas a cada scrape com timeout individual de 2s; se uma consulta falhar (Postgres ou SQS fora do ar), a gauge **mantém o último valor observado com sucesso** (nunca zera, nunca inventa) e um log sanitizado (`metric`, `errorName`, nunca a mensagem crua que poderia conter host/porta) registra a falha — o endpoint nunca deixa de responder `200` por causa de uma dependência fora do ar, nem deixa uma promise rejeitada sem tratamento (cada `refreshX()` tem seu próprio `try/catch`, então `Promise.all` nunca rejeita).

### Health checks

`GET /health/live` nunca consulta nenhuma dependência — só prova que o processo responde (checar Postgres/SQS aqui reiniciaria um processo saudável só porque uma dependência externa caiu). `GET /health/ready` verifica Postgres (`SELECT 1`, via o `EntityManager` já injetado) e SQS (`GetQueueUrl` de `wager-transactions.fifo`, via um `SQSClient` próprio do `HealthModule`, nunca o do consumidor/publisher — assim `/health/ready` funciona independente de `WAGER_TRANSACTIONS_CONSUMER_ENABLED`/`OUTBOX_PUBLISHER_ENABLED`), cada checagem com timeout de 2s. Nenhum dos dois endpoints exige autenticação.

---

## Testes — mapeamento para a seção 13

| Item da seção 13 | Onde está provado |
|---|---|
| 1. mesma aposta 50x em paralelo | `idempotency.concurrency.ts` |
| 2. disputa de saldo (cenário seção 8) | `process-bet.concurrency.ts`, `wager-transaction-sqs-consumer.concurrency.ts`, `multi-instance-processes.concurrency.ts` |
| 3. wallets distintas em paralelo | `wager-transaction-sqs-consumer.concurrency.ts` (5 wallets), `multi-instance-processes.concurrency.ts` |
| 4. ≥ 3 processos/instâncias simultâneos | `multi-instance-processes.concurrency.ts` (3 processos reais do SO via `Bun.spawn`) |
| 5. worker morto depois do commit, antes do ack | `wager-transaction-sqs-consumer.concurrency.ts` (redelivery da mesma `messageId`) |
| 6. dois publishers sobre a mesma outbox | `outbox-publisher.concurrency.ts` |
| 7. `ROLLBACK`/`REFUND` antes da referência | `retry-pending-reference.concurrency.ts`, `reference-reuse.concurrency.ts` |
| 8. reinício do serviço, consistência final | `service-restart.concurrency.ts` (processo real morto com `SIGKILL`, processo novo retoma) |

`spawn-app-instance.ts` é o helper compartilhado pelos itens 4 e 8: sobe `bun run src/main.ts` como processo real (`Bun.spawn`, via `process.execPath` — portável entre Windows/macOS), sincroniza por polling em `GET /health/ready` (nunca sleep fixo), encerra com `SIGTERM` + espera limitada, escalando para `SIGKILL` só como fallback de limpeza.

Os itens 4 e 8 vivem em `bun run test:concurrency:processes`, separado de `test:concurrency`, porque cada processo real custa um boot completo da aplicação Nest — mantém a suíte do dia a dia rápida (~10s) e reserva os testes mais caros (~8-25s cada) para antes de qualquer entrega ou mudança nessa área.

---

## Decisões e trade-offs

- **SQL cru no caminho financeiro crítico, entidades MikroORM só no resto** — explicado em [Stack e por que MikroORM](#stack-e-por-que-mikroorm). Trade-off aceito: mais verboso (cada query é escrita à mão), mas dá controle explícito sobre `SAVEPOINT` e sobre exatamente que linha está sendo travada, sem depender do Unit of Work adivinhar a ordem certa.
- **`MessageDeduplicationId` sempre derivado de um identificador já persistido** (o `id` da `OutboxMessage`, o `messageId` do envelope), nunca de um hash incidental do corpo — evita que duas publicações do mesmo evento lógico, serializadas de forma levemente diferente, sejam tratadas como mensagens diferentes pelo SQS.
- **`ContentBasedDeduplication=false`** nas 3 filas, deliberado — a mesma razão acima: dedup automático do SQS é conveniente, mas incidental; a deduplicação real é sempre explícita (Inbox, `MessageDeduplicationId` estável).
- **Sem DLQ para `wager-transaction-events.fifo`** — a tabela `outbox_messages` já é a fonte persistente de retry; criar uma DLQ para essa fila duplicaria esse mecanismo sem nenhum consumidor real definido para drenar a DLQ.
- **`maxReceiveCount=5`** para a DLQ de entrada — número provisório, centralizado em uma única variável em `create-queues.sh`, fácil de revisar.
- **Dois backoffs exponenciais separados** (referência pendente vs. publicação da Outbox) em vez de uma abstração compartilhada — mesma forma matemática, causas diferentes; decisão vinculante de manter os dois problemas desacoplados no código mesmo parecendo redundante à primeira vista.
- **Cursor de paginação do ledger opaco mas não assinado** (`ledger-cursor.ts`) — base64url de `${createdAt.toISOString()}|${id}`, decodificação estrita (qualquer desvio de formato é erro, nunca um valor aproximado). Não carrega HMAC porque não é usado como mecanismo de autorização, só de paginação — decisão consciente de simplicidade (nível júnior: sem sofisticação sem necessidade).
- **Reconciliação nunca corrige** — só relata (`consistent`, `difference`, `checkedEntries`), loga e incrementa métrica quando diverge; corrigir automaticamente esconderia um bug real atrás de uma UPDATE silenciosa.
- **Gauges de métrica "sob falha" preservam o último valor bom** em vez de zerar ou omitir — decisão explícita para não fabricar um "0" que pareceria um estado real (fila vazia) quando na verdade a consulta falhou.
- **`test:concurrency:processes` separado de `test:concurrency`** — ver [Testes](#testes--mapeamento-para-a-seção-13).

## Limitações conhecidas

- **Deadlock/lock-wait-timeout genuínos não são reproduzíveis neste sistema** — nenhum fluxo trava mais de uma wallet por transação, e `lock_timeout` não está configurado. `wager_lock_conflicts_total` e o catch de `DeadlockException`/`LockWaitTimeoutException` (`submit-wager-transaction.use-case.ts`) são provados corretos contra as classes de exceção reais via um `EntityManager` fake controlado (`submit-wager-transaction-lock-conflict.spec.ts`), não contra um deadlock real — o sistema estruturalmente não pode produzir um hoje. Documentado desde o bloco do consumidor SQS.
- **Nenhum consumidor real de `wager-transaction-events.fifo`** — a fila de saída da Outbox existe e é publicada corretamente (provado em `service-restart.concurrency.ts` recebendo e inspecionando mensagens reais), mas não há um serviço consumidor no escopo deste desafio.
- **OpenTelemetry e dashboard** — explicitamente opcionais pelo desafio (seção 12); não implementados.
- **`bun run test:load`** — o diferencial opcional de teste de carga não foi implementado; não há medição de throughput/p50/p95/p99 registrada.
- **Timing exato de "matar o processo no meio de uma transação SQL"** (`service-restart.concurrency.ts`) não é tentado — a janela é de microssegundos, mirar nisso via timing de sinal do SO seria inerentemente instável, e exigiria instrumentar o código financeiro só para o teste. A garantia de que uma transação nunca fica "meio aplicada" está coberta pelos testes de rollback forçado (`outbox-publisher.integration.ts`, `retry-pending-reference.integration.ts`), onde o Postgres desfaz sozinho uma transação cuja conexão morre no meio dela; o que `service-restart.concurrency.ts` prova, adicionalmente, é que trabalho **já commitado e ainda não publicado/resolvido** sobrevive à morte do processo.

## Autenticação

**Não implementada nesta entrega** — não existe nenhum guard, mesmo que no-op, nem uma interface de porta de identidade no código. Decisão deliberada: a seção 2 do desafio deixa explícito que autenticação vale **0 pontos** na avaliação (seção 14) e não deve competir por tempo com correção financeira, concorrência, idempotência e mensageria — que juntas somam 70 dos 100 pontos e são as áreas com falhas eliminatórias. Todo o tempo disponível foi investido nelas.

Desenho que seria adotado se implementado, para discussão: integrar um Identity Provider externo via OIDC (Keycloak ou Zitadel, ambos sugeridos pelo desafio, ambos sobem em Docker Compose) — nunca uma tabela própria de usuários com hash de senha. Na prática, isso significaria um `AuthGuard` do NestJS (por exemplo via `APP_GUARD` global em `app.module.ts`) validando um JWT emitido pelo IdP, com os endpoints de health permanecendo abertos (a seção 2 do desafio já isenta esse caso) e as mensagens vindas da fila continuando a ser tratadas como canal interno confiável — a identidade do provedor contida no payload (`providerId`) continuaria sujeita às mesmas validações de domínio que já existem hoje, independentemente de autenticação de transporte.
