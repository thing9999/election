import 'dotenv/config'; // 스로틀 설정이 데코레이터에서 읽히므로 가장 먼저 로드한다
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // 종료 시 정리(감사 로그 반출 큐 비우기 등)가 실제로 돌게 한다.
  // 이게 없으면 SIGTERM 을 받아도 곧장 죽어서 아직 안 나간 반출이 유실된다.
  app.enableShutdownHooks();

  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:5173',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,          // DTO 에 없는 필드는 잘라낸다
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 프록시(ALB/Nginx) 뒤에서 req.ip 가 실제 클라이언트 IP 가 되도록
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // 검증용으로 쓰로틀을 완화한 채로 뜬 경우 — 절대 조용히 넘어가면 안 된다.
  // E2E 는 유권자 40명을 연속 인증하므로 운영 쓰로틀에서는 429 가 나고,
  // 그래서 완화가 필요한데, 그 상태가 운영으로 새어 들어가면 무차별 대입이 열린다.
  if (process.env.E2E_RELAXED_THROTTLE === '1') {
    if (process.env.NODE_ENV === 'production') {
      new Logger('Bootstrap').error(
        'E2E_RELAXED_THROTTLE 이 켜진 채로 production 에서 기동하려 했습니다. 중단합니다.',
      );
      process.exit(1);
    }
    const l = new Logger('Bootstrap');
    l.warn('─────────────────────────────────────────────');
    l.warn('쓰로틀이 검증용으로 완화되어 있습니다 (E2E_RELAXED_THROTTLE=1).');
    l.warn('이 프로세스는 운영에 쓰지 마세요.');
    l.warn('─────────────────────────────────────────────');
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on http://localhost:${port}/api`);
}
bootstrap();
