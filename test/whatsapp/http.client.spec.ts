import axios from 'axios';
import { HttpClientService } from '../../src/modules/whatsapp/services/clients/http.client';

jest.mock('axios');

describe('HttpClientService', () => {
  let service: HttpClientService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new HttpClientService();
  });

  it('should POST and return data', async () => {
    (axios.post as any).mockResolvedValue({ data: { ok: true } });
    const res = await service.post('http://localhost/x', { a: 1 });
    expect(res).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and then succeed', async () => {
    (axios.post as any)
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce({ data: { ok: true } });

    const res = await service.post('http://localhost/x', { a: 1 }, undefined, { retries: 2, baseDelayMs: 1, maxDelayMs: 2 });
    expect(res).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalledTimes(3);
  });

  it('should GET and return data and headers', async () => {
    (axios.get as any).mockResolvedValue({ data: Buffer.from('ok'), headers: { 'x': 'y' } });
    const res = await service.get('http://localhost/y');
    expect(res.headers.x).toBe('y');
    expect(res.data).toBeInstanceOf(Buffer);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});


