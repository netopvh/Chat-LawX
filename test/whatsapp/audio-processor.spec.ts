import { AudioProcessor } from '../../src/modules/whatsapp/services/media/audio-processor';

describe('AudioProcessor', () => {
  const uploadService = {
    convertAudioToMp3: jest.fn(),
    convertAudioSimple: jest.fn(),
    uploadAudioFile: jest.fn(),
  } as any;
  const aiService = {
    processAudioForLegalConsultation: jest.fn(),
  } as any;
  let proc: AudioProcessor;

  beforeEach(() => {
    jest.resetAllMocks();
    proc = new AudioProcessor(uploadService, aiService);
  });

  it('convertToMp3WithFallback uses mp3 when available', async () => {
    const buf = Buffer.from('a');
    uploadService.convertAudioToMp3.mockResolvedValue(Buffer.from('b'));
    const out = await proc.convertToMp3WithFallback(buf);
    expect(out.toString()).toBe('b');
  });

  it('convertToMp3WithFallback falls back to simple then original', async () => {
    const buf = Buffer.from('a');
    uploadService.convertAudioToMp3.mockRejectedValue(new Error('fail'));
    uploadService.convertAudioSimple.mockResolvedValue(Buffer.from('c'));
    const out = await proc.convertToMp3WithFallback(buf);
    expect(out.toString()).toBe('c');
  });

  it('uploadAudio delegates to upload service', async () => {
    uploadService.uploadAudioFile.mockResolvedValue('url');
    const url = await proc.uploadAudio(Buffer.from('x'), 'audio.mp3');
    expect(url).toBe('url');
  });

  it('transcribe delegates to ai service', async () => {
    aiService.processAudioForLegalConsultation.mockResolvedValue('text');
    const text = await proc.transcribe(Buffer.from('x'));
    expect(text).toBe('text');
  });
});



