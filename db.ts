import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface LogEvent {
  level: 'INFO' | 'WARN' | 'ERROR';
  layer: 'api' | 'db';
  client: 'web' | 'cli';
  operation: string;
  status: 'success' | 'error';
  request_id: string;
  message: string;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

/** Escreve um evento de log: uma linha JSON no stdout (visível em `docker compose logs`). */
export function logEvent(event: LogEvent): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
}

/** Gera o hash da senha com scrypt + salt aleatório (formato `salt:hash`). Nunca guarda a senha em texto puro. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

/** Compara a senha informada com o hash guardado, em tempo constante. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

/** Acesso ao SQLite. Todas as consultas SQL da aplicação ficam neste arquivo. */
export class Db {
  private readonly conn: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.conn = new Database(file);
    this.conn.exec(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      )`,
    );
  }

  /** Cria o usuário inicial se ele ainda não existir. */
  seedUser(username: string, password: string): void {
    const exists = this.conn.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!exists) {
      this.conn
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(username, hashPassword(password));
    }
    logEvent({
      level: 'INFO',
      layer: 'db',
      client: 'web',
      operation: 'seed_user',
      status: 'success',
      request_id: 'startup',
      message: exists ? 'Usuário inicial já existia' : 'Usuário inicial criado',
    });
  }

  /** Busca um usuário pelo nome (usada no login). Registra o log da camada db com o mesmo request_id da API. */
  findUserByUsername(username: string, requestId: string, client: 'web' | 'cli'): UserRow | undefined {
    const row = this.conn
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;
    logEvent({
      level: 'INFO',
      layer: 'db',
      client,
      operation: 'select_user',
      status: 'success',
      request_id: requestId,
      message: row ? 'Usuário encontrado' : 'Usuário não encontrado',
    });
    return row;
  }

  close(): void {
    this.conn.close();
  }
}
