import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class ExternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const providedToken: string | undefined = request.headers['x-external-token'] as string | undefined;

    const expectedToken = process.env.EXTERNAL_API_TOKEN;
    if (!expectedToken) {
      // Se não configurado, não permitir por segurança
      throw new UnauthorizedException('External token não configurado');
    }

    if (!providedToken || providedToken !== expectedToken) {
      throw new UnauthorizedException('Token inválido');
    }

    return true;
  }
}


