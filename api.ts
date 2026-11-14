import 'reflect-metadata';
import {
  Body,
  CanActivate,
  Controller,
  DynamicModule,
  ExecutionContext,
  Get,
  Header,
  HttpCode,
  Inject,
  INestApplication,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Db, LogEvent, logEvent, verifyPassword } from './db';

const TOKEN_TTL_SECONDS = 3600;

export interface AppConfig {
  port: number;
  dbPath: string;
  user: string;
  password: string;
  secret: string;
}

/** Lê a configuração das variáveis de ambiente (os padrões servem só para desenvolvimento). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/app.db',
    user: env.APP_USER ?? 'admin',
    password: env.APP_PASSWORD ?? 'admin123',
    secret: env.TOKEN_SECRET ?? randomBytes(32).toString('hex'),
  };
}

export interface WebRequest {
  requestId: string;
  user?: string;
  headers: Record<string, string | undefined>;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function apiLog(
  requestId: string,
  level: LogEvent['level'],
  operation: string,
  status: LogEvent['status'],
  message: string,
): void {
  logEvent({ level, layer: 'api', client: 'web', operation, status, request_id: requestId, message });
}

/** Gera um request_id por requisição; o mesmo valor é repassado ao banco para correlacionar os logs. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: WebRequest, res: { setHeader(name: string, value: string): void }, next: () => void): void {
    req.requestId = randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  }
}

@Injectable()
export class AuthService {
  constructor(
    @Inject('DB') private readonly db: Db,
    @Inject('TOKEN_SECRET') private readonly secret: string,
  ) {}

  /** Token assinado (HMAC-SHA256) no formato `payload.assinatura`, com expiração. */
  sign(username: string, ttlSeconds = TOKEN_TTL_SECONDS): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ sub: username, exp })).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  /** Retorna o usuário dono do token, ou null se o token for inválido/expirado. */
  verify(token: string): string | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.signature(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Math.floor(Date.now() / 1000) ? sub : null;
  }

  login(username: unknown, password: unknown, requestId: string): { token: string; username: string } {
    const user = this.db.findUserByUsername(String(username), requestId, 'web');
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      apiLog(requestId, 'WARN', 'login', 'error', 'Falha de autenticação: credenciais inválidas');
      throw new UnauthorizedException('Usuário ou senha inválidos');
    }
    apiLog(requestId, 'INFO', 'login', 'success', 'Login realizado com sucesso');
    return { token: this.sign(user.username), username: user.username };
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

/** Protege rotas: exige `Authorization: Bearer <token>`; caso contrário responde 401. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<WebRequest>();
    const header = req.headers['authorization'] ?? '';
    const user = this.auth.verify(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!user) {
      apiLog(req.requestId, 'WARN', 'authenticate', 'error', 'Falha de autenticação: token ausente ou inválido');
      throw new UnauthorizedException();
    }
    req.user = user;
    return true;
  }
}

@Controller('api/web')
export class WebController {
  constructor(private readonly auth: AuthService) {}

  @Get('health')
  health(@Req() req: WebRequest): { status: string } {
    apiLog(req.requestId, 'INFO', 'health', 'success', 'Healthcheck respondeu');
    return { status: 'ok' };
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginBody, @Req() req: WebRequest): { token: string; username: string } {
    return this.auth.login(body.username, body.password, req.requestId);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: WebRequest): { username: string } {
    apiLog(req.requestId, 'INFO', 'me', 'success', 'Sessão validada');
    return { username: req.user as string };
  }
}

/** Entrega a página inicial (index.html). */
@Controller()
export class PageController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  index(): string {
    return readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  }
}

@Module({})
export class AppModule implements NestModule {
  static register(db: Db, secret: string): DynamicModule {
    return {
      module: AppModule,
      controllers: [WebController, PageController],
      providers: [
        { provide: 'DB', useValue: db },
        { provide: 'TOKEN_SECRET', useValue: secret },
        AuthService,
        AuthGuard,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

/** Sobe a aplicação: abre o SQLite, cria o usuário inicial e começa a escutar. */
export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<INestApplication> {
  const config = loadConfig(env);
  const db = new Db(config.dbPath);
  db.seedUser(config.user, config.password);
  const app = await NestFactory.create(AppModule.register(db, config.secret), { logger: false });
  await app.listen(config.port);
  logEvent({
    level: 'INFO',
    layer: 'api',
    client: 'web',
    operation: 'startup',
    status: 'success',
    request_id: 'startup',
    message: `API escutando na porta ${config.port}`,
  });
  return app;
}
