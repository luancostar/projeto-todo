import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, AuthService } from '../api';
import { run, USAGE } from '../cli';
import { Db, localDateString } from '../db';

// Issue #12: indicadores do dashboard pela CLI (consulta no banco, endpoint da API e comando da CLI).

let written: string[];
const logs = () => written.map((line) => JSON.parse(line));

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

const TODAY = '2026-11-16';

function seeded(): Db {
  const db = new Db(':memory:');
  const base = { description: 'Descrição' };
  db.createRecord({ ...base, title: 'A', category: 'Trabalho', priority: 'alta', due_date: '2026-11-01' }, 'd1', 'cli');
  db.createRecord({ ...base, title: 'B', category: 'Trabalho', priority: 'alta', due_date: TODAY }, 'd2', 'cli');
  db.createRecord({ ...base, title: 'C', category: 'Estudo', priority: 'media', due_date: '2026-12-20' }, 'd3', 'cli');
  db.createRecord({ ...base, title: 'D', category: 'Pessoal', priority: 'baixa', due_date: null }, 'd4', 'cli');
  db.createRecord({ ...base, title: 'E', category: 'Estudo', priority: 'baixa', due_date: '2020-01-01' }, 'd5', 'cli');
  written = [];
  return db;
}

describe('localDateString', () => {
  it('formata a data local como AAAA-MM-DD, com zeros à esquerda', () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(localDateString(new Date(2026, 10, 16, 23, 59))).toBe('2026-11-16');
  });

  it('usa a data de hoje quando nenhuma é informada', () => {
    expect(localDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Db.getCliDashboardStats (issue #12)', () => {
  it('conta os 3 indicadores: prazo, prioridade e categoria', () => {
    const db = seeded();
    const stats = db.getCliDashboardStats('req-d1', TODAY);
    expect(stats.total).toBe(5);
    // atrasada = prazo anterior a hoje; vencer hoje e não ter prazo contam como "em dia"
    expect(stats.byStatus).toEqual({ em_dia: 3, atrasada: 2 });
    expect(stats.byPriority).toEqual({ baixa: 2, media: 1, alta: 2 });
    // da maior para a menor contagem; empate em ordem alfabética
    expect(stats.byCategory).toEqual([
      { category: 'Estudo', count: 2 },
      { category: 'Trabalho', count: 2 },
      { category: 'Pessoal', count: 1 },
    ]);
    db.close();
  });

  it('registra o log da camada db com client cli e o request_id recebido', () => {
    const db = seeded();
    db.getCliDashboardStats('req-d2', TODAY);
    expect(logs()[0]).toMatchObject({
      level: 'INFO',
      layer: 'db',
      client: 'cli',
      operation: 'dashboard_cli_stats',
      status: 'success',
      request_id: 'req-d2',
      message: 'Indicadores calculados para 5 tarefa(s)',
    });
    db.close();
  });

  it('usa a data de hoje por padrão (prazos de 2020 estão atrasados e de 2099, em dia)', () => {
    const db = new Db(':memory:');
    db.createRecord({ title: 'Velha', description: 'Descrição', category: 'Geral', priority: 'alta', due_date: '2020-01-01' }, 'r', 'cli');
    db.createRecord({ title: 'Futura', description: 'Descrição', category: 'Geral', priority: 'alta', due_date: '2099-12-31' }, 'r', 'cli');
    expect(db.getCliDashboardStats('req-d3').byStatus).toEqual({ em_dia: 1, atrasada: 1 });
    db.close();
  });

  it('devolve tudo zerado e sem categorias quando não há tarefas', () => {
    const db = new Db(':memory:');
    expect(db.getCliDashboardStats('req-d4', TODAY)).toEqual({
      total: 0,
      byStatus: { em_dia: 0, atrasada: 0 },
      byPriority: { baixa: 0, media: 0, alta: 0 },
      byCategory: [],
    });
    db.close();
  });

  it('conta na prioridade só baixa, media e alta, mas a tarefa entra no total', () => {
    const db = new Db(':memory:');
    db.createRecord({ title: 'X', description: 'Descrição', category: 'Geral', priority: 'urgente' }, 'r', 'cli');
    const stats = db.getCliDashboardStats('req-d5', TODAY);
    expect(stats.total).toBe(1);
    expect(stats.byPriority).toEqual({ baixa: 0, media: 0, alta: 0 });
    db.close();
  });
});

describe('GET /api/cli/dashboard (issue #12)', () => {
  let app: INestApplication;
  let emptyApp: INestApplication;
  let db: Db;
  let emptyDb: Db;
  let cliToken: string;
  let webToken: string;

  const get = (server: INestApplication, token: string | null = cliToken) => {
    const req = request(server.getHttpServer()).get('/api/cli/dashboard');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    db = new Db(':memory:');
    db.seedUser('admin', 'segredo123');
    emptyDb = new Db(':memory:');
    emptyDb.seedUser('admin', 'segredo123');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(db, 'chave-dashboard')] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const emptyModule = await Test.createTestingModule({
      imports: [AppModule.register(emptyDb, 'chave-dashboard')],
    }).compile();
    emptyApp = emptyModule.createNestApplication();
    await emptyApp.init();

    const auth = moduleRef.get(AuthService);
    cliToken = auth.sign('admin', 3600, 'cli');
    webToken = auth.sign('admin');

    // datas fixas muito distantes de hoje, para o resultado não depender do dia da execução
    const base = { description: 'Descrição' };
    db.createRecord({ ...base, title: 'A', category: 'Trabalho', priority: 'alta', due_date: '2020-01-01' }, 's', 'cli');
    db.createRecord({ ...base, title: 'B', category: 'Trabalho', priority: 'media', due_date: '2099-12-31' }, 's', 'cli');
    db.createRecord({ ...base, title: 'C', category: 'Estudo', priority: 'baixa', due_date: null }, 's', 'cli');
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await emptyApp.close();
    db.close();
    emptyDb.close();
  });

  it('responde 401 sem token, com token inválido e com o token da Web', async () => {
    expect((await get(app, null)).status).toBe(401);
    expect((await get(app, 'abc.def')).status).toBe(401);
    expect((await get(app, webToken)).status).toBe(401);
    expect(logs().find((l) => l.operation === 'authenticate')).toMatchObject({ client: 'cli', level: 'WARN' });
  });

  it('devolve os 3 indicadores no mesmo formato do dashboard Web', async () => {
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 3,
      byStatus: { em_dia: 2, atrasada: 1 },
      byPriority: { baixa: 1, media: 1, alta: 1 },
      byCategory: [
        { category: 'Trabalho', count: 2 },
        { category: 'Estudo', count: 1 },
      ],
    });
  });

  it('devolve exatamente os mesmos valores do dashboard Web para os mesmos dados', async () => {
    const web = await request(app.getHttpServer())
      .get('/api/web/dashboard')
      .set('Authorization', `Bearer ${webToken}`);
    const cli = await get(app);
    expect(web.status).toBe(200);
    expect(cli.body).toEqual(web.body);
  });

  it('devolve zeros e categorias vazias quando não há tarefas', async () => {
    const res = await get(emptyApp);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: { em_dia: 0, atrasada: 0 },
      byPriority: { baixa: 0, media: 0, alta: 0 },
      byCategory: [],
    });
  });

  it('correlaciona os logs da API e do banco e não expõe o token', async () => {
    const res = await get(app);
    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'dashboard_stats');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'dashboard_cli_stats');
    expect(apiLog).toMatchObject({ level: 'INFO', status: 'success', client: 'cli', request_id: requestId });
    expect(dbLog).toMatchObject({ level: 'INFO', status: 'success', client: 'cli', request_id: requestId });
    expect(written.join('')).not.toContain(cliToken);
  });
});

describe('run: dashboard (issue #12)', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
  };
  const reply = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  const data = {
    total: 7,
    byStatus: { em_dia: 5, atrasada: 2 },
    byPriority: { baixa: 2, media: 1, alta: 4 },
    byCategory: [
      { category: 'Estudo', count: 2 },
      { category: 'Trabalho', count: 2 },
      { category: 'Geral', count: 1 },
      { category: 'Pessoal', count: 1 },
      { category: 'Projetos', count: 1 },
    ],
  };

  it('chama GET /api/cli/dashboard com o Bearer token e mostra os 3 indicadores em texto', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(200, data));

    expect(await run(['dashboard'], { TODO_TOKEN: 'token-teste' }, c.io, fetchFn)).toBe(0);
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/dashboard');
    expect(fetchFn.mock.calls[0][1].method).toBe('GET');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer token-teste');
    expect(c.out).toEqual([
      [
        'Indicadores (7 tarefas)',
        '',
        '1. Cumprimento de prazo',
        '   Em dia / No prazo  5 (71%)',
        '   Atrasadas          2 (29%)',
        '',
        '2. Por prioridade',
        '   Alta   4 (57%)',
        '   Média  1 (14%)',
        '   Baixa  2 (29%)',
        '',
        '3. Por categoria',
        '   Estudo    2 (29%)',
        '   Trabalho  2 (29%)',
        '   Geral     1 (14%)',
        '   Pessoal   1 (14%)',
        '   Projetos  1 (14%)',
      ].join('\n'),
    ]);
  });

  it('aceita o token pela opção --token e usa o singular com uma tarefa', async () => {
    const c = capture();
    const one = {
      total: 1,
      byStatus: { em_dia: 1, atrasada: 0 },
      byPriority: { baixa: 0, media: 1, alta: 0 },
      byCategory: [{ category: 'Geral', count: 1 }],
    };
    const fetchFn = jest.fn().mockResolvedValue(reply(200, one));

    expect(await run(['dashboard', '--token', 'manual'], {}, c.io, fetchFn)).toBe(0);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer manual');
    expect(c.out[0]).toContain('Indicadores (1 tarefa)');
    expect(c.out[0]).toContain('Em dia / No prazo  1 (100%)');
  });

  it('mostra 0% e "(nenhuma categoria)" quando não há tarefas', async () => {
    const c = capture();
    const empty = {
      total: 0,
      byStatus: { em_dia: 0, atrasada: 0 },
      byPriority: { baixa: 0, media: 0, alta: 0 },
      byCategory: [],
    };

    expect(await run(['dashboard', '--token', 'abc'], {}, c.io, jest.fn().mockResolvedValue(reply(200, empty)))).toBe(0);
    expect(c.out[0]).toContain('Indicadores (0 tarefas)');
    expect(c.out[0]).toContain('Atrasadas          0 (0%)');
    expect(c.out[0]).toContain('   (nenhuma categoria)');
  });

  it('sem token ainda chama a API, que responde 401, e retorna 1', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(401, { message: 'Unauthorized' }));

    expect(await run(['dashboard'], { TODO_TOKEN: '' }, c.io, fetchFn)).toBe(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(c.err).toEqual(['Erro HTTP 401 - Unauthorized']);
  });

  it('retorna 1 quando a API não responde', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockRejectedValue(new Error('fetch failed'));

    expect(await run(['dashboard', '--token', 'abc'], { API_URL: 'http://api:3000' }, c.io, fetchFn)).toBe(1);
    expect(c.err[0]).toBe('Não foi possível conectar à API em http://api:3000: fetch failed');
  });

  it('a ajuda lista o comando dashboard', () => {
    expect(USAGE).toContain('dashboard');
    expect(USAGE).toContain('/api/cli/dashboard');
  });
});
