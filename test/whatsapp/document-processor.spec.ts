import { DocumentProcessor } from '../../src/modules/whatsapp/services/media/document-processor';

describe('DocumentProcessor', () => {
  const uploadService = { uploadDocumentFile: jest.fn() } as any;
  const http = { post: jest.fn() } as any;
  let proc: DocumentProcessor;

  beforeEach(() => {
    jest.resetAllMocks();
    proc = new DocumentProcessor(uploadService, http);
  });

  it('detects pdf mime', () => {
    const pdfHeader = Buffer.from('%PDF-1.4');
    expect(proc.detectDocumentMime(pdfHeader)).toBe('application/pdf');
  });

  it('validates supported mime', () => {
    expect(proc.isSupportedDocumentType('application/pdf')).toBe(true);
    expect(proc.isSupportedDocumentType('text/plain')).toBe(false);
  });

  it('generates file name by mime', () => {
    const name = proc.generateFileName('application/pdf');
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('formats analysis (PT)', () => {
    const text = proc.formatDocumentAnalysisForUser({
      documentType: 'Contrato',
      parties: ['A', 'B'],
      mainObjective: 'Teste',
      importantPoints: ['P1'],
      relevantClauses: ['C1'],
      deadlinesAndValues: 'Prazo X',
      identifiedRisks: ['R1'],
      recommendations: ['Reco'],
      executiveSummary: 'Resumo'
    }, 'PT');
    expect(text).toContain('ANÁLISE JURÍDICA DO DOCUMENTO');
    expect(text).toContain('Contrato');
  });
});


