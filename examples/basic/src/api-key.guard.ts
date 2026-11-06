import type { CanActivate, ManifestRoute, RequestContext } from '@kivinjs/core';
import { Injectable } from '@kivinjs/decorators';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: RequestContext, route: ManifestRoute) {
    if (route.method !== 'POST') {
      return true;
    }

    return context.request.headers.get('x-api-key') === 'secret';
  }
}
