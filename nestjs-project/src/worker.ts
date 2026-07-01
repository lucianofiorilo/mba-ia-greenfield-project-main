import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';

// Video worker entrypoint (TD-05): a standalone Nest application context with no
// HTTP listener. The open DB pool and Redis/BullMQ connections keep the process
// alive; `enableShutdownHooks` lets SIGTERM/SIGINT close them gracefully.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(
    'Video worker started — listening on the video-processing queue',
    'Worker',
  );
}
void bootstrap();
