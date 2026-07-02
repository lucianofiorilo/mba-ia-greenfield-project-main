import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { WorkerModule } from './worker.module';
import { StorageService } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';

describe('WorkerModule', () => {
  it('compiles the standalone context with TypeOrm, BullMQ queue and StorageModule', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    // DI wiring is resolvable: DB connection, the registered queue and the
    // storage adapter the processor (SI-03.9) will depend on.
    expect(module.get(DataSource)).toBeDefined();
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    expect(module.get(StorageService)).toBeDefined();

    await module.close();
  }, 30000);
});
