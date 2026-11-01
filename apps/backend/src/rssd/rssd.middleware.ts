import { Injectable, NestMiddleware, HttpException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from '@gitroom/backend/services/auth/auth.middleware';
import { RssdService } from './rssd.service';
const { ownerContext } = require('../../../../rssd/owner-context.cjs');

@Injectable()
export class RssdMiddleware implements NestMiddleware {
  constructor(private auth: AuthMiddleware, private rssd: RssdService) {}
  async use(req: Request, res: Response, next: NextFunction) {
    try {
      if (req.path.endsWith('/mcp') && req.headers.origin) {
        const allowed = [process.env.FRONTEND_URL, process.env.MAIN_URL].filter(Boolean).map(url => new URL(url!).origin);
        if (!allowed.includes(req.headers.origin)) throw new HttpException('Invalid MCP request origin', 403);
      }
      const bearer = req.headers.authorization;
      if (bearer) {
        if (!bearer.startsWith('Bearer ')) throw new HttpException('Invalid device credential', 401);
        (req as any).rssd = await this.rssd.store.authenticate(bearer.slice(7));
        next(); return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!req.is('application/json')) throw new HttpException('JSON content type required', 415);
        if (req.cookies?.auth && !req.headers.auth) {
          const allowed = [process.env.FRONTEND_URL, process.env.MAIN_URL].filter(Boolean).map(url => new URL(url!).origin);
          if (!req.headers.origin || !allowed.includes(req.headers.origin)) throw new HttpException('Invalid request origin', 403);
        }
      }
      await this.auth.use(req, res, () => {
        const user = (req as any).user, org = (req as any).org;
        (req as any).rssd = ownerContext(user, org);
        next();
      });
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      if (error?.status) throw new HttpException({message: error.message, code: error.code}, error.status);
      throw error;
    }
  }
}
