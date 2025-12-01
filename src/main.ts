import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
  });

  // Настраиваем разумные лимиты размера запроса
  // С оптимизацией (отправка только videoId) это не критично,
  // но оставляем для обратной совместимости
  app.use((req, res, next) => {
    const bodyParser = require('body-parser');
    bodyParser.json({ limit: '10mb' })(req, res, (err) => {
      if (err) {
        console.error('Body parser error:', err);
        return res.status(413).json({
          statusCode: 413,
          message: 'Request payload too large. Please use videoId instead of data URLs.',
          error: 'Payload Too Large'
        });
      }
      next();
    });
  });

  // Включить CORS
  app.enableCors({
    origin: '*',
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, X-Requested-With, X-CSRF-Token, X-Api-Version',
  });

  // Включить валидацию
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  // Подключить глобальный фильтр исключений
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 Application is running on: ${await app.getUrl()}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
}
bootstrap();