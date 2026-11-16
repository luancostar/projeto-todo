
/**
 * CLI do To-Do List (issues #7 e #8).
 * Fala somente com a API REST (`/api/cli/*`); nunca acessa o banco diretamente.
 * Uso via Compose: `docker compose run --rm cli <comando> [opções]`.
 */

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  help: boolean;
  error?: string;
}

interface ApiResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

const DEFAULT_API_URL = 'http://localhost:3000';

const VALUE_FLAGS = new Set([
  'api-url',
  'username',
  'password',
  'token',
  'id',
  'title',
  'description',
  'category',
  'priority',
  'due-date',
]);

const FLAG_ALIASES: Record<string, string> = {
  u: 'username',
  p: 'password',
  i: 'id',
};

export const USAGE = `To-Do List CLI

Uso: cli <comando> [opções]

Comandos:
  help       Mostra esta ajuda
  health     Consulta o healthcheck da API (GET /api/cli/health, público)
  token      Obtém o token Bearer (POST /api/cli/token) e o imprime
  whoami     Mostra o usuário do token (GET /api/cli/me, exige token)
  create     Cadastra uma tarefa (POST /api/cli/records, exige token)
  update     Edita uma tarefa (PUT /api/cli/records/:id, exige token)

Opções:
  --api-url <url>          Endereço da API (env API_URL, padrão ${DEFAULT_API_URL})
  -u, --username <u>       Usuário do comando token (env CLI_USER)
  -p, --password <p>       Senha do comando token (env CLI_PASSWORD)
  --token <token>          Token dos comandos protegidos (env TODO_TOKEN)
  -i, --id <id>            ID da tarefa para edição
  --title <texto>          Título da tarefa
  --description <texto>    Descrição da tarefa
  --category <categoria>   Categoria da tarefa
  --priority <prioridade>  Prioridade: baixa, media ou alta
  --due-date <data>        Data de vencimento (YYYY-MM-DD)
  -h, --help               Mostra esta ajuda

Códigos de saída: 0 sucesso, 1 erro na API ou na conexão, 2 uso incorreto.`;

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

/** Interpreta `comando --opção valor` e `--opção=valor`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const rawName = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^-{1,2}/, '');
      const name = FLAG_ALIASES[rawName] ?? rawName;

      if (!VALUE_FLAGS.has(name)) {
        return { command: '', flags, help, error: `Opção desconhecida: ${arg}` };
      }

      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);

      if (value === undefined) {
        return { command: '', flags, help, error: `A opção ${arg} exige um valor` };
      }

      flags[name] = value;
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0] ?? '', flags, help };
}

/** Chama a API e devolve status e corpo JSON. */
async function callApi(
  fetchFn: FetchFn,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<ApiResult> {
  const res = await fetchFn(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  return { ok: res.ok, status: res.status, data };
}

/** Mostra o erro devolvido pela API em stderr e retorna código 1. */
function reportHttpError(io: CliIo, result: ApiResult): number {
  const detail = result.data.message ? ` - ${String(result.data.message)}` : '';
  io.err(`Erro HTTP ${result.status}${detail}`);
  return 1;
}

/** Executa a CLI. Retorna o código de saída sem chamar process.exit. */
export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = defaultIo,
  fetchFn: FetchFn = fetch,
): Promise<number> {
  const args = parseArgs(argv);

  if (args.error) {
    io.err(args.error);
    io.err('Use "help" para ver os comandos.');
    return 2;
  }

  if (args.help || args.command === 'help' || args.command === '') {
    io.out(USAGE);
    return 0;
  }

  const baseUrl = (args.flags['api-url'] ?? env.API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');

  try {
    switch (args.command) {
      case 'health': {
        const result = await callApi(fetchFn, 'GET', `${baseUrl}/api/cli/health`, {});

        if (!result.ok) return reportHttpError(io, result);

        io.out(JSON.stringify(result.data));
        return 0;
      }

      case 'token': {
        const username = args.flags.username ?? env.CLI_USER;
        const password = args.flags.password ?? env.CLI_PASSWORD;

        if (!username || !password) {
          io.err('Informe usuário e senha: --username/--password ou as variáveis CLI_USER/CLI_PASSWORD.');
          return 2;
        }

        const result = await callApi(
          fetchFn,
          'POST',
          `${baseUrl}/api/cli/token`,
          {},
          { username, password },
        );

        if (!result.ok) return reportHttpError(io, result);

        io.out(String(result.data.token));
        return 0;
      }

      case 'whoami': {
        const token = args.flags.token ?? env.TODO_TOKEN;
        const headers: Record<string, string> = token
          ? { Authorization: `Bearer ${token}` }
          : {};

        const result = await callApi(fetchFn, 'GET', `${baseUrl}/api/cli/me`, headers);

        if (!result.ok) return reportHttpError(io, result);

        io.out(JSON.stringify(result.data));
        return 0;
      }

      case 'create':
      case 'update': {
        const token = args.flags.token ?? env.TODO_TOKEN;

        if (!token) {
          io.err('Informe o token: --token ou a variável TODO_TOKEN.');
          return 2;
        }

        const requiredFields = ['title', 'description', 'category', 'priority'];
        const missingFields = requiredFields.filter((field) => !args.flags[field]);

        if (missingFields.length > 0) {
          io.err(`Informe os campos obrigatórios: ${missingFields.map((field) => `--${field}`).join(', ')}.`);
          return 2;
        }

        if (args.command === 'update') {
          const id = Number(args.flags.id);

          if (!args.flags.id || !Number.isInteger(id) || id <= 0) {
            io.err('Informe um ID válido para edição usando --id.');
            return 2;
          }
        }

        const body: Record<string, string> = {
          title: args.flags.title,
          description: args.flags.description,
          category: args.flags.category,
          priority: args.flags.priority,
        };

        if (args.flags['due-date']) {
          body.due_date = args.flags['due-date'];
        }

        const headers = { Authorization: `Bearer ${token}` };

        const isCreate = args.command === 'create';
        const method = isCreate ? 'POST' : 'PUT';
        const url = isCreate
          ? `${baseUrl}/api/cli/records`
          : `${baseUrl}/api/cli/records/${args.flags.id}`;

        const result = await callApi(fetchFn, method, url, headers, body);

        if (!result.ok) return reportHttpError(io, result);

        io.out(JSON.stringify(result.data));
        return 0;
      }

      default:
        io.err(`Comando desconhecido: ${args.command}`);
        io.err('Use "help" para ver os comandos.');
        return 2;
    }
  } catch (error) {
    io.err(`Não foi possível conectar à API em ${baseUrl}: ${(error as Error).message}`);
    return 1;
  }
}
