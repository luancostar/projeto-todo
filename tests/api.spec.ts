import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, AuthService, bootstrap, loadConfig } from '../api';
import { Db } from '../db';

let written: string[];
let db: Db;
let app: INestApplication;
let auth: AuthService;

const logs = () => written.map((line) => JSON.parse(line));

beforeAll(async () => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  db = new Db(':memory:');
  db.seedUser('admin', 'segredo123');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(db, 'chave-de-teste')],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  auth = moduleRef.get(AuthService);
  jest.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  db.close();
});

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

describe('GET /api/web/health', () => {
  it('responde 200 sem autenticação e devolve o request_id no cabeçalho', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(logs()[0]).toMatchObject({ layer: 'api', client: 'web', operation: 'health', status: 'success' });
  });
});

describe('GET /', () => {
  it('entrega a página inicial', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('To-Do List');
  });
});

describe('POST /api/web/login', () => {
  it('autentica o usuário inicial e correlaciona os logs da API e do banco', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'admin', password: 'segredo123' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('admin');
    expect(typeof res.body.token).toBe('string');

    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'login');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'select_user');
    expect(apiLog).toMatchObject({ status: 'success', level: 'INFO', client: 'web', request_id: requestId });
    expect(dbLog).toMatchObject({ status: 'success', client: 'web', request_id: requestId });
  });

  it('não expõe senha nem token nos logs', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'admin', password: 'segredo123' });
    const everything = written.join('');
    expect(everything).not.toContain('segredo123');
    expect(everything).not.toContain(res.body.token);
  });

  it('responde 401 com senha errada e registra WARN', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'admin', password: 'errada' });
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.layer === 'api' && l.operation === 'login')).toMatchObject({
      level: 'WARN',
      status: 'error',
    });
    expect(written.join('')).not.toContain('errada');
  });

  it('responde 401 com usuário inexistente', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'ninguem', password: 'segredo123' });
    expect(res.status).toBe(401);
  });

  it('responde 401 quando o corpo vem vazio', async () => {
    const res = await request(app.getHttpServer()).post('/api/web/login');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/web/me', () => {
  it('responde 401 sem token', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/me');
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.operation === 'authenticate')).toMatchObject({ level: 'WARN', status: 'error' });
  });

  it('responde 401 com token malformado', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/me').set('Authorization', 'Bearer abc');
    expect(res.status).toBe(401);
  });

  it('responde 401 com assinatura de tamanho diferente', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/me').set('Authorization', 'Bearer abc.def');
    expect(res.status).toBe(401);
  });

  it('responde 401 com assinatura adulterada de mesmo tamanho', async () => {
    const token = auth.sign('admin');
    const last = token.slice(-1) === 'A' ? 'B' : 'A';
    const res = await request(app.getHttpServer())
      .get('/api/web/me')
      .set('Authorization', `Bearer ${token.slice(0, -1)}${last}`);
    expect(res.status).toBe(401);
  });

  it('responde 401 com token expirado', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/web/me')
      .set('Authorization', `Bearer ${auth.sign('admin', -10)}`);
    expect(res.status).toBe(401);
  });

  it('responde 200 com token válido', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'admin', password: 'segredo123' });
    const res = await request(app.getHttpServer())
      .get('/api/web/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'admin' });
  });
});

describe('loadConfig', () => {
  it('usa os padrões de desenvolvimento', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 3000, dbPath: './data/app.db', user: 'admin', password: 'admin123' });
    expect(config.secret).toHaveLength(64);
  });

  it('lê as variáveis de ambiente', () => {
    expect(
      loadConfig({ PORT: '8080', DB_PATH: '/x/y.db', APP_USER: 'u', APP_PASSWORD: 'p', TOKEN_SECRET: 's' }),
    ).toEqual({ port: 8080, dbPath: '/x/y.db', user: 'u', password: 'p', secret: 's' });
  });
});

describe('bootstrap', () => {
  it('sobe a aplicação, cria o usuário inicial e permite login', async () => {
    const server = await bootstrap({
      PORT: '0',
      DB_PATH: ':memory:',
      APP_USER: 'u',
      APP_PASSWORD: 'p',
      TOKEN_SECRET: 's',
    });
    const res = await request(server.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'u', password: 'p' });
    expect(res.status).toBe(200);
    expect(logs().some((l) => l.operation === 'startup' && l.status === 'success')).toBe(true);
    await server.close();
  });
});
