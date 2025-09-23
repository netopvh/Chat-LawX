import { MediaDownloader } from '../../src/modules/whatsapp/services/media/media-downloader';

describe('MediaDownloader', () => {
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'EVOLUTION_API_URL') return 'http://evo';
      if (k === 'EVOLUTION_INSTANCE_NAME') return 'inst';
      if (k === 'EVOLUTION_API_KEY') return 'key';
      return undefined;
    })
  } as any;
  const http = { post: jest.fn(), get: jest.fn() } as any;
  let downloader: MediaDownloader;

  beforeEach(() => {
    jest.resetAllMocks();
    downloader = new MediaDownloader(config, http);
  });

  it('downloads image via base64 endpoint', async () => {
    http.post.mockResolvedValue({ base64: Buffer.from('x').toString('base64') });
    const buf = await downloader.downloadImageFromMessage({ key: { id: 'abc' }, message: { imageMessage: {} } });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(http.post).toHaveBeenCalled();
  });
});


