import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { WhatsAppModule } from '../../src/modules/whatsapp/whatsapp.module';
import { WhatsAppService } from '../../src/modules/whatsapp/whatsapp.service';

describe('WhatsAppController (e2e)', () => {
  let app: INestApplication;
  const serviceMock = { handleWebhook: jest.fn() } as any;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [WhatsAppModule],
    })
      .overrideProvider(WhatsAppService)
      .useValue(serviceMock)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/whatsapp/webhook (POST) should return success true', async () => {
    serviceMock.handleWebhook.mockResolvedValue(undefined);
    await request(app.getHttpServer())
      .post('/whatsapp/webhook')
      .send({ event: 'messages.upsert', data: [] })
      .expect(200)
      .expect({ success: true });
  });

  it('/whatsapp/webhook (POST) should return 500 on error', async () => {
    serviceMock.handleWebhook.mockRejectedValue(new Error('boom'));
    await request(app.getHttpServer())
      .post('/whatsapp/webhook')
      .send({ event: 'messages.upsert', data: [] })
      .expect(500);
  });
});


