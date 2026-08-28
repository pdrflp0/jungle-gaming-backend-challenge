import { createServer } from 'node:net';
import { waitFor } from './sqs-test-helpers';

/**
 * So para os testes de processos reais da secao 13 do CHALLENGE.md — nunca
 * usado por codigo de producao. Sobe `bun run src/main.ts` como um PROCESSO
 * DO SISTEMA OPERACIONAL de verdade, independente do processo Bun que roda
 * os testes.
 *
 * Diferente de wager-transaction-sqs-consumer.concurrency.ts e
 * outbox-publisher.concurrency.ts (Blocos 9b.2/9c), que ja provam ausencia
 * de corrida com dois OBJETOS concorrentes dentro do MESMO processo
 * (`orm.em.fork()` + `SQSClient` proprios cada), este helper cruza um limite
 * real de processo do SO — memoria, event loop e handles de rede proprios
 * por instancia.
 */

export interface SpawnAppInstanceOptions {
  port: number;
  /** undefined = usa o default de main.ts (liga). Passe explicitamente para decidir. */
  consumerEnabled?: boolean;
  outboxPublisherEnabled?: boolean;
  pendingReferenceWorkerEnabled?: boolean;
  /** Env vars adicionais — usado sobretudo para reduzir o long-poll do SQS a poucos segundos em teste. */
  extraEnv?: Record<string, string>;
  readyTimeoutMs?: number;
}

export interface AppInstance {
  readonly port: number;
  readonly baseUrl: string;
  readonly proc: ReturnType<typeof Bun.spawn>;
  /** SIGTERM + espera graciosa por `proc.exited`; so escala para SIGKILL se estourar o timeout. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Falha cedo e com mensagem clara — nunca deixa um teste tentar subir uma
 * instancia numa porta ocupada e travar num timeout de readiness confuso.
 */
export async function requireFreePorts(ports: number[]): Promise<void> {
  for (const port of ports) {
    if (!(await isPortFree(port))) {
      throw new Error(
        `Porta ${port} ja esta em uso — libere-a (pare outro processo/instancia usando essa porta) antes de rodar este teste de processos reais.`,
      );
    }
  }
}

function boolEnvString(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

async function killAndWait(
  proc: ReturnType<typeof Bun.spawn>,
  signal: 'SIGTERM' | 'SIGKILL',
  timeoutMs: number,
): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }
  proc.kill(signal);
  const exited = proc.exited.then(() => true as const);
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  const finishedInTime = await Promise.race([exited, timedOut]);
  if (!finishedInTime && proc.exitCode === null) {
    // Fallback de limpeza — nunca o caminho normal (ver kill() abaixo).
    proc.kill('SIGKILL');
    await proc.exited;
  }
}

/**
 * Sobe a aplicacao inteira como processo real e so retorna quando
 * `GET /health/ready` responder 200 — sincronizacao por polling com timeout,
 * nunca um sleep fixo. Se a instancia nunca ficar pronta, mata o processo
 * (SIGKILL — nada para desligar graciosamente, ela nunca terminou de subir)
 * e relanca o erro original de timeout.
 */
export async function spawnAppInstance(options: SpawnAppInstanceOptions): Promise<AppInstance> {
  const env: Record<string, string> = { ...process.env, PORT: String(options.port) };

  const consumer = boolEnvString(options.consumerEnabled);
  if (consumer !== undefined) env.WAGER_TRANSACTIONS_CONSUMER_ENABLED = consumer;

  const publisher = boolEnvString(options.outboxPublisherEnabled);
  if (publisher !== undefined) env.OUTBOX_PUBLISHER_ENABLED = publisher;

  const pendingRef = boolEnvString(options.pendingReferenceWorkerEnabled);
  if (pendingRef !== undefined) env.PENDING_REFERENCE_WORKER_ENABLED = pendingRef;

  Object.assign(env, options.extraEnv ?? {});

  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: process.cwd(),
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;

  try {
    await waitFor(
      async () => {
        try {
          const res = await fetch(`${baseUrl}/health/ready`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: options.readyTimeoutMs ?? 20_000,
        intervalMs: 200,
        description: `instancia em ${baseUrl} pronta (GET /health/ready)`,
      },
    );
  } catch (error) {
    await killAndWait(proc, 'SIGKILL', 5_000);
    throw error;
  }

  return {
    port: options.port,
    baseUrl,
    proc,
    kill: (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => killAndWait(proc, signal, 10_000),
  };
}
