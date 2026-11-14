import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Db, hashPassword, logEvent, verifyPassword } from '../db';

let written: string[];

beforeEach(() => {
  written = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const logs = () => written.map((line) => JSON.parse(line));

describe('senhas', () => {
  it('gera hash com salt e nunca guarda a senha em texto puro', () => {
    const first = hashPassword('segredo');
    const second = hashPassword('segredo');
    expect(first).not.toContain('segredo');
    expect(first).not.toEqual(second);
  });

  it('verifica a senha correta e rejeita a errada', () => {
    const stored = hashPassword('segredo');
    expect(verifyPassword('segredo', stored)).toBe(true);
    expect(verifyPassword('outra', stored)).toBe(false);
  });
});

describe('logEvent', () => {
  it('escreve uma linha JSON com os campos obrigatórios', () => {
    logEvent({
      level: 'INFO',
      layer: 'api',
      client: 'cli',
      operation: 'create',
      status: 'success',
      request_id: 'req-123',
      message: 'Registro criado',
    });
    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    const entry = logs()[0];
    expect(Object.keys(entry)).toEqual([
      'timestamp',
      'level',
      'layer',
      'client',
      'operation',
      'status',
      'request_id',
      'message',
    ]);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });
});

describe('Db', () => {
  it('cria o usuário inicial uma única vez', () => {
    const db = new Db(':memory:');
    db.seedUser('admin', 'segredo');
    const first = db.findUserByUsername('admin', 'req-1', 'web');
    db.seedUser('admin', 'segredo');
    const second = db.findUserByUsername('admin', 'req-2', 'web');

    expect(first?.id).toBe(second?.id);
    expect(first?.password_hash).not.toContain('segredo');
    const seedMessages = logs()
      .filter((entry) => entry.operation === 'seed_user')
      .map((entry) => entry.message);
    expect(seedMessages).toEqual(['Usuário inicial criado', 'Usuário inicial já existia']);
    db.close();
  });

  it('busca usuário e registra log da camada db com o request_id recebido', () => {
    const db = new Db(':memory:');
    db.seedUser('admin', 'segredo');
    written = [];

    expect(db.findUserByUsername('admin', 'req-abc', 'cli')?.username).toBe('admin');
    expect(db.findUserByUsername('ninguem', 'req-def', 'web')).toBeUndefined();

    const [found, missing] = logs();
    expect(found).toMatchObject({ layer: 'db', client: 'cli', request_id: 'req-abc', message: 'Usuário encontrado' });
    expect(missing).toMatchObject({ layer: 'db', client: 'web', request_id: 'req-def', message: 'Usuário não encontrado' });
    db.close();
  });

  it('cria a pasta do arquivo SQLite quando necessário', () => {
    const dir = mkdtempSync(join(tmpdir(), 'todo-'));
    const file = join(dir, 'nova-pasta', 'app.db');
    const db = new Db(file);
    expect(existsSync(file)).toBe(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
