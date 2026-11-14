# To-Do List (Web + CLI)

Projeto da avaliação prática de Git e GitHub. Lista de tarefas com Web (React), API (NestJS) e banco (SQLite), tudo rodando exclusivamente por **Docker Compose**.

**Pré-requisitos no host:** apenas Docker e Docker Compose, além de navegador e terminal.

## Arquivos de produção

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Toda a Web (HTML, CSS e React via CDN embutidos) |
| `api.ts` | API NestJS: endpoints, autenticação e logs da API |
| `db.ts` | Acesso ao SQLite e logs da camada de banco |
| `cli.ts` | CLI (chega na issue #7) |
| `README.md` | Execução e documentação de cada issue |

---

## Issue #1: Estrutura Web (início, login, logs e testes)

### Como iniciar a Web

```bash
docker compose up --build
```

Quando os logs mostrarem `API escutando na porta 3000`, abra **http://localhost:3000** no navegador.

Para parar: `Ctrl+C` (ou `docker compose down`).

Os dados ficam no volume `db-data`; para zerar tudo use:

```bash
docker compose down -v
```

### Usuário inicial e configuração

Existe um único usuário inicial, criado automaticamente na primeira execução. Ele é configurado por variáveis de ambiente (sem senha real no repositório):

| Variável | Padrão (só desenvolvimento) | Para que serve |
|---|---|---|
| `APP_USER` | `admin` | Nome do usuário inicial |
| `APP_PASSWORD` | `admin123` | Senha do usuário inicial (guardada com hash scrypt + salt) |
| `TOKEN_SECRET` | valor de exemplo no compose | Segredo que assina os tokens de login |

Para trocar, copie `.env.example` para `.env`, edite e suba de novo:

```bash
cp .env.example .env
docker compose up --build
```

Se o volume já existe, o usuário não é recriado. Use `docker compose down -v` para começar do zero.

### Como fazer login

**Pela tela:** abra http://localhost:3000, informe usuário e senha e clique em **Entrar**. Credenciais erradas mostram uma mensagem de erro (a API responde HTTP 401).

**Pela API:**

```bash
# healthcheck (público)
curl http://localhost:3000/api/web/health

# login: devolve {"token": "...", "username": "admin"}
curl -X POST http://localhost:3000/api/web/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# rota protegida: exige o token; sem ele (ou inválido) responde 401
curl http://localhost:3000/api/web/me \
  -H "Authorization: Bearer TOKEN"
```

### Endpoints desta issue

| Método | Rota | Autenticação | Resposta |
|---|---|---|---|
| GET | `/api/web/health` | pública | 200 `{"status":"ok"}` |
| POST | `/api/web/login` | pública | 200 com token; 401 se as credenciais forem inválidas |
| GET | `/api/web/me` | Bearer token | 200 com o usuário; 401 sem token válido |

### Como consultar os logs

Cada operação gera **uma linha JSON por evento** no stdout, uma na camada `api` e outra na camada `db` (quando acessa o banco), com o **mesmo `request_id`**:

```bash
docker compose logs app
docker compose logs -f app
docker compose logs --no-log-prefix app | grep '"operation":"login"'
```

Campos: `timestamp` (ISO 8601 UTC), `level` (`INFO`/`WARN`/`ERROR`), `layer` (`api`/`db`), `client` (`web`/`cli`), `operation`, `status` (`success`/`error`), `request_id` e `message`.

Senhas e tokens nunca são registrados. O `request_id` também volta no cabeçalho de resposta `x-request-id`.

Exemplo de um login (duas linhas, mesmo `request_id`):

```json
{"timestamp":"2026-11-14T18:00:00.000Z","level":"INFO","layer":"db","client":"web","operation":"select_user","status":"success","request_id":"6f1c...","message":"Usuário encontrado"}
{"timestamp":"2026-11-14T18:00:00.050Z","level":"INFO","layer":"api","client":"web","operation":"login","status":"success","request_id":"6f1c...","message":"Login realizado com sucesso"}
```

### Testes e cobertura

```bash
docker compose run --rm test
```

Roda o Jest dentro do contêiner e imprime a cobertura. A execução **falha** se a cobertura de linhas de `api.ts` e `db.ts` ficar abaixo de 100%. O `cli.ts` entra na medição quando for criado.

### Estrutura de apoio

`Dockerfile`, `docker-compose.yml`, `package.json`, `tsconfig.json`, `jest.config.js`, `tests/*.spec.ts`, `.gitignore`, `.dockerignore`, `.env.example` e `.github/PULL_REQUEST_TEMPLATE.md` são arquivos auxiliares (infraestrutura, configuração, testes e template de PR).