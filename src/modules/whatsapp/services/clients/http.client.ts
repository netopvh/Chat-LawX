import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';

interface RetryOptions {
  retries: number;
  baseDelayMs: number; // backoff base
  maxDelayMs: number;
}

@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private jitter(delay: number): number {
    const jitter = Math.random() * 0.3 * delay; // 30% jitter
    return Math.min(delay + jitter, delay * 1.3);
  }

  private async withRetry<T>(fn: () => Promise<T>, url: string, method: string, retry: RetryOptions): Promise<T> {
    let attempt = 0;
    let lastError: any;
    let delay = retry.baseDelayMs;

    while (attempt <= retry.retries) {
      const start = Date.now();
      try {
        const result = await fn();
        const dur = Date.now() - start;
        this.logger.log(`${method.toUpperCase()} ${url} - ${dur}ms (attempt ${attempt + 1})`);
        return result;
      } catch (error) {
        lastError = error;
        const dur = Date.now() - start;
        this.logger.warn(`${method.toUpperCase()} ${url} failed in ${dur}ms (attempt ${attempt + 1}/${retry.retries + 1}) - ${error?.code || error?.message}`);
        if (attempt === retry.retries) break;
        await this.sleep(this.jitter(Math.min(delay, retry.maxDelayMs)));
        delay = Math.min(delay * 2, retry.maxDelayMs);
        attempt++;
      }
    }
    throw lastError;
  }

  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig, retry?: Partial<RetryOptions>): Promise<T> {
    const r = { retries: 2, baseDelayMs: 300, maxDelayMs: 3000, ...(retry || {}) } as RetryOptions;
    const finalConfig: AxiosRequestConfig = { timeout: 120000, ...(config || {}) };
    return this.withRetry<T>(
      async () => {
        const res = await axios.post(url, data, finalConfig);
        return res.data as T;
      },
      url,
      'post',
      r
    );
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig, retry?: Partial<RetryOptions>): Promise<{ data: T; headers: any }> {
    const r = { retries: 2, baseDelayMs: 300, maxDelayMs: 3000, ...(retry || {}) } as RetryOptions;
    const finalConfig: AxiosRequestConfig = { timeout: 120000, responseType: 'arraybuffer', ...(config || {}) };
    return this.withRetry<{ data: T; headers: any }>(
      async () => {
        const res = await axios.get(url, finalConfig);
        return { data: res.data as T, headers: res.headers };
      },
      url,
      'get',
      r
    );
  }
}


